import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "@opencode-pet/protocol"
import type { AppEvent, AppSnapshot } from "../src/shared/ipc"
import { InstanceHub } from "../src/main/instances"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for InstanceHub state")
    await delay(10)
  }
}

function frameText(frame: unknown): string {
  if (typeof frame === "string") return frame
  if (frame instanceof ArrayBuffer) return new TextDecoder().decode(frame)
  if (ArrayBuffer.isView(frame)) return new TextDecoder().decode(frame)
  return String(frame)
}

function session(id: string, updatedAt = Date.now()): SessionState {
  return { id, title: id, directory: "/test", status: "idle", todos: { total: 0, completed: 0 }, updatedAt }
}

async function liveHub(initial: SessionState[] = []) {
  const clients = new Set<{ send(frame: string): void }>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, instance) {
      if (instance.upgrade(request)) return undefined
      return new Response("WebSocket required", { status: 426 })
    },
    websocket: {
      message(socket, frame) {
        if ((JSON.parse(frameText(frame)) as { type: string }).type === "auth") {
          clients.add(socket)
          socket.send(JSON.stringify({ type: "snapshot", sessions: initial }))
        }
      },
      close(socket) { clients.delete(socket) },
    },
  })
  cleanup.push(() => server.stop(true))
  const directory = await mkdtemp(join(tmpdir(), "opencode-pet-performance-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, port: server.port, token: "isolated-performance-test-token-32",
    serverUrl: "http://127.0.0.1:4096", directory, worktree: directory, startedAt: Date.now(),
  }))
  const snapshots: AppSnapshot[] = []
  const events: AppEvent[] = []
  const hub = new InstanceHub(directory, {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onEvent: (event) => events.push(event),
  })
  cleanup.push(() => hub.stop())
  await hub.start()
  await waitFor(() => clients.size === 1 && hub.getSnapshot().connections[0]?.connected === true)
  return { hub, snapshots, events, send(message: unknown) {
    for (const client of clients) client.send(JSON.stringify(message))
  } }
}

describe("InstanceHub snapshot emission", () => {
  test("suppresses unchanged scans and duplicate server state, but emits real changes", async () => {
    const token = "snapshot-dedupe-token-that-is-long-enough"
    const authenticatedClients = new Set<{ send(frame: string): void }>()
    const server = Bun.serve<{ authenticated: boolean }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, instance) {
        if (instance.upgrade(request, { data: { authenticated: false } })) return undefined
        return new Response("WebSocket required", { status: 426 })
      },
      websocket: {
        open() {},
        message(socket, frame) {
          const message = JSON.parse(frameText(frame)) as { type?: unknown; token?: unknown }
          if (!socket.data.authenticated && message.type === "auth" && message.token === token) {
            socket.data.authenticated = true
            authenticatedClients.add(socket)
            socket.send(JSON.stringify({ type: "snapshot", sessions: [] }))
          }
        },
        close(socket) {
          authenticatedClients.delete(socket)
        },
      },
    })
    cleanup.push(() => server.stop(true))

    const discoveryDirectory = await mkdtemp(join(tmpdir(), "opencode-pet-instances-"))
    cleanup.push(() => rm(discoveryDirectory, { recursive: true, force: true }))
    await writeFile(join(discoveryDirectory, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      port: server.port,
      token,
      serverUrl: "http://127.0.0.1:4096",
      directory: discoveryDirectory,
      worktree: discoveryDirectory,
      startedAt: Date.now(),
    }))

    const snapshots: AppSnapshot[] = []
    const hub = new InstanceHub(discoveryDirectory, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onEvent: () => undefined,
    })
    cleanup.push(() => hub.stop())
    await hub.start()
    await waitFor(() => snapshots.some((snapshot) => snapshot.connections[0]?.connected === true))
    await waitFor(() => authenticatedClients.size === 1)

    const stableCount = snapshots.length
    const stableSnapshot = hub.getSnapshot()
    for (const client of authenticatedClients) {
      client.send(JSON.stringify({ type: "snapshot", sessions: [] }))
    }
    await delay(100)
    expect(snapshots).toHaveLength(stableCount)

    // Let the two-second discovery timer run once: an unchanged file must not
    // trigger another renderer snapshot.
    await delay(2_100)
    expect(snapshots).toHaveLength(stableCount)
    expect(hub.getSnapshot()).toBe(stableSnapshot)

    const session = {
      id: "session-1",
      title: "Real update",
      directory: discoveryDirectory,
      status: "busy",
      todos: { total: 1, completed: 0 },
      updatedAt: Date.now(),
    }
    for (const client of authenticatedClients) {
      client.send(JSON.stringify({ type: "session.upsert", session }))
    }
    await waitFor(() => snapshots.length === stableCount + 1)
    expect(snapshots.at(-1)?.sessions[0]?.title).toBe("Real update")

    for (const client of authenticatedClients) {
      client.send(JSON.stringify({ type: "snapshot", sessions: [session] }))
    }
    await delay(100)
    expect(snapshots).toHaveLength(stableCount + 1)
  }, 10_000)

  test("emits an empty initial snapshot again after stop and restart", async () => {
    const discoveryDirectory = await mkdtemp(join(tmpdir(), "opencode-pet-empty-"))
    cleanup.push(() => rm(discoveryDirectory, { recursive: true, force: true }))
    const snapshots: AppSnapshot[] = []
    const hub = new InstanceHub(discoveryDirectory, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onEvent: () => undefined,
    })
    cleanup.push(() => hub.stop())

    await hub.start()
    expect(snapshots).toEqual([{ connections: [], sessions: [] }])
    hub.stop()
    await hub.start()
    expect(snapshots).toEqual([
      { connections: [], sessions: [] },
      { connections: [], sessions: [] },
    ])
  })

  test("coalesces an event flood and keeps one cached aggregate between changes", async () => {
    const { hub, snapshots, send } = await liveHub()
    const initialCount = snapshots.length
    const started = performance.now()
    for (let index = 0; index < 1_000; index += 1) {
      send({ type: "session.upsert", session: { ...session("busy", index), status: "busy", title: `update-${index}` } })
    }
    await waitFor(() => snapshots.at(-1)?.sessions[0]?.title === "update-999")
    const emissions = snapshots.length - initialCount
    expect(emissions).toBeLessThan(10)
    expect(hub.getSnapshot()).toBe(hub.getSnapshot())
    console.info(`InstanceHub flood: 1000 updates -> ${emissions} aggregate snapshots in ${Math.round(performance.now() - started)} ms`)
  })

  test("publishes pending updates immediately for permission, removal, error and reply events", async () => {
    const { snapshots, events, send } = await liveHub()
    const waiting = { ...session("waiting"), permission: { id: "permission", title: "Shell", patterns: ["bun test"], createdAt: Date.now() } }
    send({ type: "session.upsert", session: session("normal") })
    send({ type: "session.upsert", session: waiting })
    await waitFor(() => snapshots.at(-1)?.sessions.some((item) => item.permission?.id === "permission") === true)
    expect(snapshots.at(-1)?.sessions).toHaveLength(2)
    send({ type: "permission.replied", sessionID: "waiting", permissionID: "permission", response: "once", ok: true })
    await waitFor(() => events.length === 1)
    expect(snapshots.at(-1)?.sessions.find((item) => item.id === "waiting")?.permission).toBeUndefined()
    send({ type: "session.upsert", session: { ...session("normal"), error: "failure" } })
    send({ type: "notify", event: { kind: "error", sessionID: "normal", createdAt: Date.now() } })
    await waitFor(() => events.length === 2)
    expect(snapshots.at(-1)?.sessions.find((item) => item.id === "normal")?.error).toBe("failure")
    send({ type: "session.remove", sessionID: "normal" })
    await waitFor(() => snapshots.at(-1)?.sessions.every((item) => item.id !== "normal") === true)
  })

  test("bounds inactive history while retaining active sessions and every ancestor", async () => {
    const initial = Array.from({ length: 300 }, (_, index) => session(`history-${index}`, index + 10))
    initial.push(
      session("grandparent", 0),
      { ...session("parent", 0), parentID: "grandparent" },
      { ...session("busy", 0), parentID: "parent", status: "busy" },
      { ...session("retry", 0), status: "retry", retry: { attempt: 1, message: "Retry" } },
      { ...session("permission", 0), permission: { id: "p", title: "Shell", patterns: [], createdAt: 0 } },
    )
    const { hub } = await liveHub(initial)
    const retained = hub.getSnapshot().sessions
    expect(retained).toHaveLength(205)
    expect(retained.filter((item) => item.id.startsWith("history-"))).toHaveLength(200)
    expect(retained.some((item) => item.id === "history-0")).toBe(false)
    for (const id of ["grandparent", "parent", "busy", "retry", "permission"]) {
      expect(retained.some((item) => item.id === id)).toBe(true)
    }
  })

  test("stop cancels a pending ordinary publication and releases cached state", async () => {
    const { hub, snapshots, send } = await liveHub()
    const count = snapshots.length
    send({ type: "session.upsert", session: session("pending") })
    await waitFor(() => hub.getSnapshot().sessions.length === 1)
    hub.stop()
    await delay(100)
    expect(snapshots).toHaveLength(count)
    expect(hub.getSnapshot()).toEqual({ connections: [], sessions: [] })
  })

  test("stopping during async startup cannot publish or restart its scan timer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-pet-stop-start-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const snapshots: AppSnapshot[] = []
    const hub = new InstanceHub(directory, { onSnapshot: (snapshot) => snapshots.push(snapshot), onEvent: () => undefined })
    cleanup.push(() => hub.stop())
    const starting = hub.start()
    hub.stop()
    await starting
    expect(snapshots).toHaveLength(0)
    await hub.start()
    expect(snapshots).toEqual([{ connections: [], sessions: [] }])
  })
})
