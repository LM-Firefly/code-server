import { field, logger } from "@coder/logger"
import * as cp from "child_process"
import * as net from "net"
import * as path from "path"
import * as ipc from "../../lib/vscode/src/vs/server/ipc"
import { arrayify, generateUuid } from "../common/util"
import { rootPath } from "./constants"
import { settings } from "./settings"
import { SocketProxyProvider } from "./socket"
import { isFile } from "./util"
import { ipcMain } from "./wrapper"

export class VscodeProvider {
  public readonly serverRootPath: string
  public readonly vsRootPath: string
  private _vscode?: Promise<cp.ChildProcess>
  private timeoutInterval = 10000 // 10s, matches VS Code's timeouts.
  private readonly socketProvider = new SocketProxyProvider()

  public constructor() {
    this.vsRootPath = path.resolve(rootPath, "lib/vscode")
    this.serverRootPath = path.join(this.vsRootPath, "out/vs/server")
    ipcMain.onDispose(() => this.dispose())
  }

  public async dispose(): Promise<void> {
    this.socketProvider.stop()
    if (this._vscode) {
      const vscode = await this._vscode
      vscode.removeAllListeners()
      vscode.kill()
      this._vscode = undefined
    }
  }

  public async initialize(
    options: Omit<ipc.VscodeOptions, "startPath">,
    query: ipc.Query,
  ): Promise<ipc.WorkbenchOptions> {
    const { lastVisited } = await settings.read()
    const startPath = await this.getFirstPath([
      { url: query.workspace, workspace: true },
      { url: query.folder, workspace: false },
      options.args._ && options.args._.length > 0
        ? { url: path.resolve(options.args._[options.args._.length - 1]) }
        : undefined,
      lastVisited,
    ])

    settings.write({
      lastVisited: startPath,
      query,
    })

    const id = generateUuid()
    const vscode = await this.fork()

    logger.debug("setting up vs code...")

    this.send(
      {
        type: "init",
        id,
        options: {
          ...options,
          startPath,
        },
      },
      vscode,
    )

    const message = await this.onMessage(vscode, (message): message is ipc.OptionsMessage => {
      // There can be parallel initializations so wait for the right ID.
      return message.type === "options" && message.id === id
    })

    return message.options
  }

  private fork(): Promise<cp.ChildProcess> {
    if (this._vscode) {
      return this._vscode
    }

    logger.debug("forking vs code...")
    const vscode = cp.fork(path.join(this.serverRootPath, "fork"))

    const dispose = () => {
      vscode.removeAllListeners()
      vscode.kill()
      this._vscode = undefined
    }

    vscode.on("error", (error: Error) => {
      logger.error(error.message)
      if (error.stack) {
        logger.debug(error.stack)
      }
      dispose()
    })

    vscode.on("exit", (code) => {
      logger.error(`VS Code exited unexpectedly with code ${code}`)
      dispose()
    })

    this._vscode = this.onMessage(vscode, (message): message is ipc.ReadyMessage => {
      return message.type === "ready"
    }).then(() => vscode)

    return this._vscode
  }

  /**
   * Listen to a single message from a process. Reject if the process errors,
   * exits, or times out.
   *
   * `fn` is a function that determines whether the message is the one we're
   * waiting for.
   */
  private onMessage<T extends ipc.VscodeMessage>(
    proc: cp.ChildProcess,
    fn: (message: ipc.VscodeMessage) => message is T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        proc.off("error", onError)
        proc.off("exit", onExit)
        proc.off("message", onMessage)
        clearTimeout(timeout)
      }

      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error("timed out"))
      }, this.timeoutInterval)

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`VS Code exited unexpectedly with code ${code}`))
      }

      const onMessage = (message: ipc.VscodeMessage) => {
        logger.trace("got message from vscode", field("message", message))
        if (fn(message)) {
          cleanup()
          resolve(message)
        }
      }

      proc.on("message", onMessage)
      proc.on("error", onError)
      proc.on("exit", onExit)
    })
  }

  /**
   * VS Code expects a raw socket. It will handle all the web socket frames.
   */
  public async sendWebsocket(socket: net.Socket, query: ipc.Query): Promise<void> {
    const vscode = await this._vscode
    // TLS sockets cannot be transferred to child processes so we need an
    // in-between. Non-TLS sockets will be returned as-is.
    const socketProxy = await this.socketProvider.createProxy(socket)
    this.send({ type: "socket", query }, vscode, socketProxy)
  }

  private send(message: ipc.CodeServerMessage, vscode?: cp.ChildProcess, socket?: net.Socket): void {
    if (!vscode || vscode.killed) {
      throw new Error("vscode is not running")
    }
    vscode.send(message, socket)
  }

  /**
   * Choose the first non-empty path from the provided array.
   *
   * Each array item consists of `url` and an optional `workspace` boolean that
   * indicates whether that url is for a workspace.
   *
   * `url` can be a fully qualified URL or just the path portion.
   *
   * `url` can also be a query object to make it easier to pass in query
   * variables directly but anything that isn't a string or string array is not
   * valid and will be ignored.
   */
  private async getFirstPath(
    startPaths: Array<{ url?: string | string[] | ipc.Query | ipc.Query[]; workspace?: boolean } | undefined>,
  ): Promise<ipc.StartPath | undefined> {
    for (let i = 0; i < startPaths.length; ++i) {
      const startPath = startPaths[i]
      const url = arrayify(startPath && startPath.url).find((p) => !!p)
      if (startPath && url && typeof url === "string") {
        return {
          url,
          // The only time `workspace` is undefined is for the command-line
          // argument, in which case it's a path (not a URL) so we can stat it
          // without having to parse it.
          workspace: typeof startPath.workspace !== "undefined" ? startPath.workspace : await isFile(url),
        }
      }
    }
    return undefined
  }
}
