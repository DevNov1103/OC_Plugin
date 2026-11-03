import { mkdir, readFile, readdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  decodeServerMessage,
  encodeMessage,
  isDiscoveryRecord,
  type DiscoveryRecord,
  type PermissionResponse,
  type SessionState,
} from "@opencode-pet/protocol"
import WebSocket, { type RawData } from "ws"
import type { AppEvent, AppSnapshot } from "../shared/ipc"
import { bridgeWebSocketUrl, discoveryConnectionFingerprint } from "./discovery"

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000] as const
const SCAN_INTERVAL = 2_000
const SNAPSHOT_INTERVAL = 50
const MAX_HISTORY_SESSIONS = 200

interface ConnectionState {
  id: string
  filePath: string
  record: DiscoveryRecord
  instanceLabel: string
  connected: boolean
  sessions: Map<string, SessionState>
  socket: WebSocket | undefined
  reconnectTimer: NodeJS.Timeout | undefined
  retryIndex: number
  disposed: boolean
}

interface InstanceHubCallbacks {
  onSnapshot(snapshot: AppSnapshot): void
  onEvent(event: AppEvent): void
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function instanceId(record: DiscoveryRecord): string {
  return `${record.pid}:${record.startedAt}`
}

function labelFor(record: DiscoveryRecord): string {
  const label = basename(record.worktree || record.directory)
  return label || `OpenCode ${record.pid}`
}

function sessionPriority(session: SessionState): number {
  if (session.permission) return 0
  if (session.error) return 1
  if (session.status === "retry") return 2
  if (session.status === "busy") return 3
  return 4
}

function isActive(session: SessionState): boolean {
  return session.status === "busy" || session.status === "retry" || !!session.activity || !!session.permission
}

function sameSession(left: SessionState | undefined, right: SessionState): boolean {
  if (!left) return false
  return left.id === right.id && left.parentID === right.parentID && left.title === right.title &&
    left.directory === right.directory && left.status === right.status && left.updatedAt === right.updatedAt &&
    left.error === right.error && left.todos.total === right.todos.total &&
    left.todos.completed === right.todos.completed && left.todos.current === right.todos.current &&
    left.retry?.attempt === right.retry?.attempt && left.retry?.message === right.retry?.message &&
    left.activity?.tool === right.activity?.tool && left.activity?.detail === right.activity?.detail &&
    left.activity?.since === right.activity?.since && left.permission?.id === right.permission?.id &&
    left.permission?.title === right.permission?.title && left.permission?.createdAt === right.permission?.createdAt &&
    (left.permission?.patterns.length ?? 0) === (right.permission?.patterns.length ?? 0) &&
    (left.permission?.patterns.every((pattern, index) => pattern === right.permission?.patterns[index]) ?? true)
}

/** This only trims the pet's projection, never OpenCode's source sessions. */
function trimHistory(sessions: Map<string, SessionState>): void {
  if (sessions.size <= MAX_HISTORY_SESSIONS) return
  const protectedIDs = new Set<string>()
  for (const session of sessions.values()) {
    if (!isActive(session)) continue
    let current: SessionState | undefined = session
    while (current && !protectedIDs.has(current.id)) {
      protectedIDs.add(current.id)
      current = current.parentID ? sessions.get(current.parentID) : undefined
    }
  }
  const history = [...sessions.values()]
    .filter((session) => !protectedIDs.has(session.id))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  for (const session of history.slice(MAX_HISTORY_SESSIONS)) sessions.delete(session.id)
}

function sameSessions(left: Map<string, SessionState>, right: Map<string, SessionState>): boolean {
  if (left.size !== right.size) return false
  for (const session of right.values()) if (!sameSession(left.get(session.id), session)) return false
  return true
}

export class InstanceHub {
  private readonly connections = new Map<string, ConnectionState>()
  private scanTimer: NodeJS.Timeout | undefined
  private scanInProgress: number | undefined
  private lifecycle = 0
  private stopped = true
  private snapshotTimer: NodeJS.Timeout | undefined
  private snapshotCache: AppSnapshot | undefined
  private lastPublishedSnapshot: AppSnapshot | undefined

  constructor(
    private readonly discoveryDirectory: string,
    private readonly callbacks: InstanceHubCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    const lifecycle = ++this.lifecycle
    // A restarted hub has a new renderer lifecycle and must publish its initial
    // state even when it is structurally equal to the previous run.
    this.lastPublishedSnapshot = undefined
    await mkdir(this.discoveryDirectory, { recursive: true })
    if (this.stopped || this.lifecycle !== lifecycle) return
    await this.scan()
    if (this.stopped || this.lifecycle !== lifecycle) return
    this.scanTimer = setInterval(() => void this.scan(), SCAN_INTERVAL)
    this.scanTimer.unref()
  }

  stop(): void {
    this.stopped = true
    this.lifecycle += 1
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = undefined
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = undefined
    for (const state of this.connections.values()) this.disposeConnection(state)
    this.connections.clear()
    this.snapshotCache = undefined
    this.lastPublishedSnapshot = undefined
  }

  getSnapshot(): AppSnapshot {
    if (this.snapshotCache) return this.snapshotCache
    const connections = [...this.connections.values()]
      .map((state) => ({
        id: state.id,
        directory: state.record.directory,
        connected: state.connected,
      }))
      .sort((left, right) => left.directory.localeCompare(right.directory))

    const sessions = [...this.connections.values()]
      .flatMap((state) => [...state.sessions.values()].map((session) => ({
        ...session,
        instanceId: state.id,
        instanceLabel: state.instanceLabel,
      })))
      .sort((left, right) => {
        const priority = sessionPriority(left) - sessionPriority(right)
        return priority || right.updatedAt - left.updatedAt
      })

    this.snapshotCache = { connections, sessions }
    return this.snapshotCache
  }

  replyPermission(
    targetInstanceId: string,
    sessionID: string,
    permissionID: string,
    response: PermissionResponse,
  ): void {
    const state = this.connections.get(targetInstanceId)
    if (!state || !state.connected || state.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("The selected OpenCode instance is not connected")
    }
    state.socket.send(encodeMessage({
      type: "permission.reply",
      sessionID,
      permissionID,
      response,
    }))
  }

  private async scan(): Promise<void> {
    const lifecycle = this.lifecycle
    if (this.scanInProgress === lifecycle || this.stopped) return
    this.scanInProgress = lifecycle
    try {
      const entries = await readdir(this.discoveryDirectory, { withFileTypes: true })
      if (this.stopped || this.lifecycle !== lifecycle) return
      const seenPaths = new Set<string>()

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        const filePath = join(this.discoveryDirectory, entry.name)
        seenPaths.add(filePath)

        let parsed: unknown
        try {
          parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown
        } catch (error) {
          console.warn(`Ignoring unreadable discovery file ${entry.name}`, error)
          continue
        }
        if (this.stopped || this.lifecycle !== lifecycle) return
        if (!isDiscoveryRecord(parsed)) {
          console.warn(`Ignoring invalid discovery file ${entry.name}`)
          continue
        }
        if (!isProcessAlive(parsed.pid)) {
          await rm(filePath, { force: true }).catch((error: unknown) => {
            console.warn(`Could not remove stale discovery file ${entry.name}`, error)
          })
          if (this.stopped || this.lifecycle !== lifecycle) return
          this.dropByFilePath(filePath)
          seenPaths.delete(filePath)
          continue
        }

        this.upsertConnection(filePath, parsed)
      }

      for (const state of [...this.connections.values()]) {
        if (!seenPaths.has(state.filePath)) this.dropConnection(state.id)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not scan OpenCode pet instances", error)
      }
    } finally {
      if (this.scanInProgress === lifecycle) this.scanInProgress = undefined
      if (!this.stopped && this.lifecycle === lifecycle) this.emitSnapshot()
    }
  }

  private upsertConnection(filePath: string, record: DiscoveryRecord): void {
    const id = instanceId(record)
    const pathMatch = [...this.connections.values()].find((state) => state.filePath === filePath)
    if (pathMatch && pathMatch.id !== id) this.dropConnection(pathMatch.id)

    const existing = this.connections.get(id)
    if (existing) {
      if (discoveryConnectionFingerprint(existing.record) !== discoveryConnectionFingerprint(record)) {
        this.dropConnection(existing.id)
        this.createConnection(filePath, record)
        return
      }
      const label = labelFor(record)
      if (existing.instanceLabel !== label || existing.record.directory !== record.directory) {
        existing.instanceLabel = label
        this.snapshotCache = undefined
      }
      existing.record = record
      return
    }
    this.createConnection(filePath, record)
  }

  private createConnection(filePath: string, record: DiscoveryRecord): void {
    const state: ConnectionState = {
      id: instanceId(record),
      filePath,
      record,
      instanceLabel: labelFor(record),
      connected: false,
      sessions: new Map(),
      socket: undefined,
      reconnectTimer: undefined,
      retryIndex: 0,
      disposed: false,
    }
    this.connections.set(state.id, state)
    this.snapshotCache = undefined
    this.connect(state)
  }

  private connect(state: ConnectionState): void {
    if (this.stopped || state.disposed) return
    if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return

    const socket = new WebSocket(bridgeWebSocketUrl(state.record), {
      handshakeTimeout: 5_000,
      maxPayload: 2 * 1024 * 1024,
      perMessageDeflate: false,
    })
    state.socket = socket

    socket.on("open", () => {
      if (state.disposed || state.socket !== socket) return
      socket.send(encodeMessage({ type: "auth", token: state.record.token }))
    })

    socket.on("message", (data: RawData) => {
      if (state.disposed || state.socket !== socket) return
      const message = decodeServerMessage(data)
      if (!message) return
      state.retryIndex = 0
      const connectedNow = !state.connected
      if (!state.connected) {
        // An open TCP/WebSocket is not enough: the bridge may still reject auth.
        // Its first valid protocol frame confirms this instance is usable.
        state.connected = true
        this.snapshotCache = undefined
      }

      switch (message.type) {
        case "snapshot": {
          const sessions = new Map(message.sessions.map((session) => [session.id, session]))
          trimHistory(sessions)
          if (!sameSessions(state.sessions, sessions)) {
            state.sessions = sessions
            this.snapshotCache = undefined
          }
          this.emitSnapshot()
          break
        }
        case "session.upsert": {
          const previous = state.sessions.get(message.session.id)
          if (sameSession(previous, message.session)) break
          state.sessions.set(message.session.id, message.session)
          if (!previous || previous.parentID !== message.session.parentID || isActive(previous) !== isActive(message.session)) {
            trimHistory(state.sessions)
          }
          if (!previous && !state.sessions.has(message.session.id)) break
          this.snapshotCache = undefined
          const critical = previous?.permission?.id !== message.session.permission?.id ||
            previous?.error !== message.session.error || message.session.status === "retry"
          this.emitSnapshot(critical)
          break
        }
        case "session.remove":
          if (state.sessions.delete(message.sessionID)) this.snapshotCache = undefined
          this.emitSnapshot()
          break
        case "notify":
          this.emitSnapshot()
          this.callbacks.onEvent({
            type: "notify",
            instanceId: state.id,
            instanceLabel: state.instanceLabel,
            event: message.event,
          })
          break
        case "permission.replied": {
          if (message.ok) {
            const session = state.sessions.get(message.sessionID)
            if (session?.permission?.id === message.permissionID) {
              const { permission: _permission, ...withoutPermission } = session
              state.sessions.set(message.sessionID, { ...withoutPermission, updatedAt: Date.now() })
              trimHistory(state.sessions)
              this.snapshotCache = undefined
            }
          }
          this.emitSnapshot()
          this.callbacks.onEvent({
            type: "permission.replied",
            instanceId: state.id,
            instanceLabel: state.instanceLabel,
            sessionID: message.sessionID,
            permissionID: message.permissionID,
            response: message.response,
            ok: message.ok,
            ...(message.error === undefined ? {} : { error: message.error }),
          })
          break
        }
        case "ping":
          socket.send(encodeMessage({
            type: "pong",
            ...(message.nonce === undefined ? {} : { nonce: message.nonce }),
          }))
          break
        case "ack":
        case "pong":
          this.emitSnapshot()
          break
      }
      if (connectedNow) this.emitSnapshot()
    })

    socket.on("error", (error) => {
      console.warn(`OpenCode pet connection ${state.id} failed`, error.message)
    })

    socket.on("close", () => {
      if (state.socket !== socket) return
      state.socket = undefined
      if (state.disposed || this.stopped) return
      state.connected = false
      this.snapshotCache = undefined
      this.emitSnapshot()
      this.scheduleReconnect(state)
    })
  }

  private scheduleReconnect(state: ConnectionState): void {
    if (this.stopped || state.disposed || state.reconnectTimer) return
    const delay = RECONNECT_DELAYS[Math.min(state.retryIndex, RECONNECT_DELAYS.length - 1)] ?? 10_000
    state.retryIndex += 1
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined
      this.connect(state)
    }, delay)
    state.reconnectTimer.unref()
  }

  private dropByFilePath(filePath: string): void {
    const state = [...this.connections.values()].find((candidate) => candidate.filePath === filePath)
    if (state) this.dropConnection(state.id)
  }

  private dropConnection(id: string): void {
    const state = this.connections.get(id)
    if (!state) return
    this.connections.delete(id)
    this.snapshotCache = undefined
    this.disposeConnection(state)
    this.emitSnapshot()
  }

  private disposeConnection(state: ConnectionState): void {
    state.disposed = true
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    state.reconnectTimer = undefined
    const socket = state.socket
    state.socket = undefined
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
  }

  private emitSnapshot(immediate = true): void {
    if (this.stopped) return
    if (!immediate) {
      if (!this.snapshotTimer) {
        this.snapshotTimer = setTimeout(() => {
          this.snapshotTimer = undefined
          this.emitSnapshot()
        }, SNAPSHOT_INTERVAL)
        this.snapshotTimer.unref()
      }
      return
    }
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = undefined
    const snapshot = this.getSnapshot()
    if (snapshot === this.lastPublishedSnapshot) return
    this.lastPublishedSnapshot = snapshot
    this.callbacks.onSnapshot(snapshot)
  }
}
