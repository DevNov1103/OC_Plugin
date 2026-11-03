import { describe, expect, test } from "bun:test"
import {
  decodeServerMessage,
  encodeMessage,
  type PermissionReplyMessage,
  type ServerMessage,
  type SessionState,
} from "@opencode-pet/protocol"
import { normalizeOpenCodeEvent } from "../src/normalize"
import { createBridgeServer, type BridgeServer } from "../src/server"
import { SessionStore } from "../src/state"

const EVENT_TIMEOUT_MS = 2_000

interface SocketClient {
  socket: WebSocket
  nextMessage(): Promise<ServerMessage>
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out opening the bridge WebSocket"))
    }, EVENT_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error("Bridge WebSocket failed to open"))
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("error", onError)
  })
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the bridge to close the socket")), EVENT_TIMEOUT_MS)
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer)
        resolve({ code: event.code, reason: event.reason })
      },
      { once: true },
    )
  })
}

async function connect(url: string, sockets: WebSocket[]): Promise<SocketClient> {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const queued: unknown[] = []
  const waiters: Array<(value: unknown) => void> = []
  socket.addEventListener("message", (event) => {
    const waiter = waiters.shift()
    if (waiter) waiter(event.data)
    else queued.push(event.data)
  })
  await waitForOpen(socket)

  return {
    socket,
    async nextMessage() {
      const value =
        queued.length > 0
          ? queued.shift()
          : await new Promise<unknown>((resolve, reject) => {
              let timer: ReturnType<typeof setTimeout>
              const accept = (next: unknown) => {
                clearTimeout(timer)
                resolve(next)
              }
              waiters.push(accept)
              timer = setTimeout(() => {
                const index = waiters.indexOf(accept)
                if (index >= 0) waiters.splice(index, 1)
                reject(new Error("Timed out waiting for a bridge message"))
              }, EVENT_TIMEOUT_MS)
            })
      const message = decodeServerMessage(value)
      if (!message) throw new Error(`Bridge sent an invalid server message: ${String(value)}`)
      return message
    },
  }
}

async function cleanup(bridge: BridgeServer, sockets: WebSocket[]): Promise<void> {
  await Promise.all(
    sockets.map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          socket.removeEventListener("close", finish)
          resolve()
        }
        const timer = setTimeout(finish, 250)
        socket.addEventListener("close", finish)
        try {
          socket.close(1000, "Test complete")
        } catch {
          finish()
        }
      })
    }),
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      bridge.stop(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out stopping the bridge")), EVENT_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function authenticate(client: SocketClient, token: string): void {
  client.socket.send(encodeMessage({ type: "auth", token }))
}

function injectOpenCodeEvent(bridge: BridgeServer, store: SessionStore, payload: unknown): void {
  const event = normalizeOpenCodeEvent(payload)
  if (!event) throw new Error("Test event did not normalize")
  for (const mutation of store.apply(event)) bridge.broadcast(mutation)
}

describe("plugin bridge WebSocket", () => {
  test("rejects a bad token and sends the initial snapshot after valid authentication", async () => {
    const token = "test-token-correct"
    const snapshot: SessionState[] = [
      {
        id: "ses_initial",
        title: "Initial task",
        directory: "/repo",
        status: "idle",
        todos: { total: 1, completed: 0, current: "Connect the pet" },
        updatedAt: 100,
      },
    ]
    const bridge = createBridgeServer({
      token,
      snapshot: () => snapshot,
      onPermissionReply: async () => undefined,
    })
    const sockets: WebSocket[] = []

    try {
      expect(new URL(bridge.url).hostname).toBe("127.0.0.1")

      const rejected = await connect(bridge.url, sockets)
      const rejectedClose = waitForClose(rejected.socket)
      authenticate(rejected, "test-token-wrong")
      expect(await rejectedClose).toEqual({ code: 4401, reason: "Authentication required" })

      const accepted = await connect(bridge.url, sockets)
      authenticate(accepted, token)
      expect(await accepted.nextMessage()).toEqual({ type: "snapshot", sessions: snapshot })
    } finally {
      await cleanup(bridge, sockets)
    }
  })

  test("normalizes injected events and broadcasts them only to authenticated clients", async () => {
    const token = "test-token-events"
    const store = new SessionStore({ directory: "/repo", now: () => 200 })
    const bridge = createBridgeServer({
      token,
      snapshot: () => store.snapshot(),
      onPermissionReply: async () => undefined,
    })
    const sockets: WebSocket[] = []

    try {
      const authenticated = await connect(bridge.url, sockets)
      const waitingForAuth = await connect(bridge.url, sockets)
      authenticate(authenticated, token)
      expect(await authenticated.nextMessage()).toEqual({ type: "snapshot", sessions: [] })

      injectOpenCodeEvent(bridge, store, {
        event: {
          type: "session.created",
          properties: { info: { id: "ses_event", title: "Injected task", directory: "/repo" } },
        },
      })
      const session: SessionState = {
        id: "ses_event",
        title: "Injected task",
        directory: "/repo",
        status: "idle",
        todos: { total: 0, completed: 0 },
        updatedAt: 200,
      }
      expect(await authenticated.nextMessage()).toEqual({ type: "session.upsert", session })

      // If pre-auth clients received the earlier broadcast, that event would be
      // queued ahead of this snapshot and this assertion would fail.
      authenticate(waitingForAuth, token)
      expect(await waitingForAuth.nextMessage()).toEqual({ type: "snapshot", sessions: [session] })

      injectOpenCodeEvent(bridge, store, {
        type: "todo.updated",
        properties: {
          sessionID: "ses_event",
          todos: [
            { content: "Handshake", status: "completed" },
            { content: "Stream events", status: "in_progress" },
          ],
        },
      })
      const todoUpdate: ServerMessage = {
        type: "session.upsert",
        session: {
          ...session,
          todos: { total: 2, completed: 1, current: "Stream events" },
        },
      }
      expect(await authenticated.nextMessage()).toEqual(todoUpdate)
      expect(await waitingForAuth.nextMessage()).toEqual(todoUpdate)
    } finally {
      await cleanup(bridge, sockets)
    }
  })

  test("broadcasts permission reply success and failure to every authenticated client", async () => {
    const token = "test-token-permissions"
    const received: PermissionReplyMessage[] = []
    const bridge = createBridgeServer({
      token,
      snapshot: () => [],
      async onPermissionReply(message) {
        received.push(message)
        if (message.permissionID === "per_fail") throw new Error("OpenCode rejected the reply")
      },
    })
    const sockets: WebSocket[] = []

    try {
      const sender = await connect(bridge.url, sockets)
      const observer = await connect(bridge.url, sockets)
      authenticate(sender, token)
      authenticate(observer, token)
      expect(await sender.nextMessage()).toEqual({ type: "snapshot", sessions: [] })
      expect(await observer.nextMessage()).toEqual({ type: "snapshot", sessions: [] })

      const success: PermissionReplyMessage = {
        type: "permission.reply",
        sessionID: "ses_1",
        permissionID: "per_ok",
        response: "once",
      }
      sender.socket.send(encodeMessage(success))
      const successResult: ServerMessage = {
        type: "permission.replied",
        sessionID: "ses_1",
        permissionID: "per_ok",
        response: "once",
        ok: true,
      }
      expect(await sender.nextMessage()).toEqual(successResult)
      expect(await observer.nextMessage()).toEqual(successResult)

      const failure: PermissionReplyMessage = {
        type: "permission.reply",
        sessionID: "ses_1",
        permissionID: "per_fail",
        response: "reject",
      }
      observer.socket.send(encodeMessage(failure))
      const failureResult: ServerMessage = {
        type: "permission.replied",
        sessionID: "ses_1",
        permissionID: "per_fail",
        response: "reject",
        ok: false,
        error: "OpenCode rejected the reply",
      }
      expect(await sender.nextMessage()).toEqual(failureResult)
      expect(await observer.nextMessage()).toEqual(failureResult)
      expect(received).toEqual([success, failure])
    } finally {
      await cleanup(bridge, sockets)
    }
  })
})
