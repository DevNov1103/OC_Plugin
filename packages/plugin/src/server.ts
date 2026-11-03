import {
  decodeClientMessage,
  encodeMessage,
  type PermissionReplyMessage,
  type QuestionReplyMessage,
  type ServerMessage,
  type SessionState,
} from "@opencode-pet/protocol"
import type { ServerWebSocket } from "bun"

interface SocketData {
  authenticated: boolean
  authTimer?: ReturnType<typeof setTimeout>
}

export interface BridgeServerOptions {
  token: string
  snapshot: () => SessionState[]
  authTimeoutMs?: number
  onPermissionReply: (message: PermissionReplyMessage) => Promise<void>
  onQuestionReply?: (message: QuestionReplyMessage) => Promise<void>
}

export interface BridgeServer {
  readonly port: number
  readonly url: string
  broadcast(message: ServerMessage): void
  stop(): Promise<void>
}

function sameToken(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Starts a loopback-only, token-authenticated Bun WebSocket server. */
export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const authenticated = new Set<ServerWebSocket<SocketData>>()
  const timeout = options.authTimeoutMs ?? 3_000
  const broadcast = (message: ServerMessage) => {
    const frame = encodeMessage(message)
    for (const socket of authenticated) {
      try {
        socket.send(frame)
      } catch {
        authenticated.delete(socket)
      }
    }
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, instance) {
      const url = new URL(request.url)
      if (url.pathname !== "/" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Not found", { status: 404 })
      }
      if (instance.upgrade(request, { data: { authenticated: false } })) return undefined
      return new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        socket.data.authTimer = setTimeout(() => {
          if (!socket.data.authenticated) socket.close(4401, "Authentication timeout")
        }, timeout)
      },
      message(socket, frame) {
        const message = decodeClientMessage(frame)
        if (!socket.data.authenticated) {
          if (!message || message.type !== "auth" || !sameToken(message.token, options.token)) {
            socket.close(4401, "Authentication required")
            return
          }
          socket.data.authenticated = true
          if (socket.data.authTimer) clearTimeout(socket.data.authTimer)
          delete socket.data.authTimer
          authenticated.add(socket)
          socket.send(encodeMessage({ type: "snapshot", sessions: options.snapshot() }))
          return
        }

        if (!message || message.type === "auth") {
          socket.close(4400, "Invalid message")
          return
        }
        if (message.type === "ping") {
          socket.send(encodeMessage({ type: "pong", ...(message.nonce ? { nonce: message.nonce } : {}) }))
          return
        }
        if (message.type === "permission.reply") {
          void options
            .onPermissionReply(message)
            .then(() => {
              broadcast({
                type: "permission.replied",
                sessionID: message.sessionID,
                permissionID: message.permissionID,
                response: message.response,
                ok: true,
              })
            })
            .catch((error: unknown) => {
              broadcast({
                type: "permission.replied",
                sessionID: message.sessionID,
                permissionID: message.permissionID,
                response: message.response,
                ok: false,
                error: errorText(error),
              })
            })
          return
        }
        if (message.type === "question.reply" && options.onQuestionReply) {
          void options.onQuestionReply(message).catch(() => undefined)
        }
      },
      close(socket) {
        if (socket.data.authTimer) clearTimeout(socket.data.authTimer)
        authenticated.delete(socket)
      },
    },
  })

  if (server.port === undefined) {
    void server.stop(true)
    throw new Error("Bun did not assign a TCP port to the pet bridge")
  }
  const port = server.port

  let stopped = false
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    broadcast,
    async stop() {
      if (stopped) return
      stopped = true
      for (const socket of authenticated) socket.close(1001, "Plugin disposed")
      authenticated.clear()
      // Bun stops accepting connections synchronously, but on Windows 1.3.x
      // the returned promise can remain pending after WebSockets have closed.
      void server.stop(true)
    },
  }
}
