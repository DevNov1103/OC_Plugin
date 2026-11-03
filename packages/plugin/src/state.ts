import type {
  NotificationEvent,
  PermissionRepliedMessage,
  PermissionResponse,
  SessionState,
} from "@opencode-pet/protocol"
import type { NormalizedEvent, PermissionApiVersion } from "./normalize"

export type StoreMutation =
  | { type: "session.upsert"; session: SessionState }
  | { type: "session.remove"; sessionID: string }
  | { type: "notify"; event: NotificationEvent }
  | PermissionRepliedMessage

export interface SessionStoreOptions {
  directory: string
  now?: () => number
}

type TodoRecord = Record<string, unknown>
const MAX_HISTORY_SESSIONS = 200

function record(value: unknown): TodoRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as TodoRecord)
    : undefined
}

function cloneSession(session: SessionState): SessionState {
  return {
    ...session,
    todos: { ...session.todos },
    ...(session.retry ? { retry: { ...session.retry } } : {}),
    ...(session.activity ? { activity: { ...session.activity } } : {}),
    ...(session.permission
      ? { permission: { ...session.permission, patterns: [...session.permission.patterns] } }
      : {}),
  }
}

function asPermissionResponse(value: string): PermissionResponse {
  return value === "once" || value === "always" || value === "reject" ? value : "reject"
}

function todoSummary(todos: unknown[]): SessionState["todos"] {
  let completed = 0
  let current: string | undefined
  for (const value of todos) {
    const todo = record(value)
    if (!todo) continue
    if (todo.status === "completed" || todo.status === "done") completed += 1
    if (!current && (todo.status === "in_progress" || todo.status === "in-progress" || todo.status === "doing")) {
      const text = todo.content ?? todo.text ?? todo.title
      if (typeof text === "string" && text.length > 0) current = text
    }
  }
  return { total: todos.length, completed: Math.min(completed, todos.length), ...(current ? { current } : {}) }
}

/** A deterministic projection from OpenCode's event stream to the pet protocol. */
export class SessionStore {
  readonly #sessions = new Map<string, SessionState>()
  readonly #permissionVersions = new Map<string, PermissionApiVersion>()
  readonly #completionPending = new Set<string>()
  readonly #failedRoots = new Set<string>()
  readonly #directory: string
  readonly #now: () => number
  #historyNeedsPrune = false
  #snapshotOrder: SessionState[] | undefined
  #hasPrunedHistory = false
  readonly #unverifiedSessions = new Set<string>()

  constructor(options: SessionStoreOptions) {
    this.#directory = options.directory
    this.#now = options.now ?? Date.now
  }

  snapshot(): SessionState[] {
    this.#snapshotOrder ??= [...this.#sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    return this.#snapshotOrder.map(cloneSession)
  }

  get(sessionID: string): SessionState | undefined {
    const session = this.#sessions.get(sessionID)
    return session ? cloneSession(session) : undefined
  }

  permissionVersion(permissionID: string): PermissionApiVersion | undefined {
    return this.#permissionVersions.get(permissionID)
  }

  resolvePermission(sessionID: string, permissionID: string): StoreMutation[] {
    this.#permissionVersions.delete(permissionID)
    const session = this.#sessions.get(sessionID)
    if (!session || session.permission?.id !== permissionID) return []
    delete session.permission
    session.updatedAt = this.#now()
    this.#historyNeedsPrune = true
    const mutations = [this.#upsert(session), ...this.#maybeComplete(this.#rootID(sessionID))]
    return [...mutations, ...this.#pruneHistory()]
  }

  apply(event: NormalizedEvent): StoreMutation[] {
    const mutations = this.#apply(event)
    return [...mutations, ...this.#pruneHistory()]
  }

  #apply(event: NormalizedEvent): StoreMutation[] {
    switch (event.type) {
      case "session.upsert": {
        const session = this.#ensure(event.info.id)
        const previousRootID = this.#rootID(session.id)
        if (event.info.parentID !== undefined && session.parentID !== event.info.parentID) {
          session.parentID = event.info.parentID
          this.#historyNeedsPrune = true
        }
        const rootID = this.#rootID(session.id)
        if (previousRootID === session.id && rootID !== previousRootID) {
          if (this.#completionPending.delete(previousRootID)) this.#completionPending.add(rootID)
          if (this.#failedRoots.delete(previousRootID)) this.#failedRoots.add(rootID)
        }
        this.#unverifiedSessions.delete(session.id)
        if (event.info.title !== undefined) session.title = event.info.title
        if (event.info.directory !== undefined) session.directory = event.info.directory
        session.updatedAt = this.#now()
        return [this.#upsert(session)]
      }
      case "session.remove": {
        const rootID = this.#rootID(event.sessionID)
        const removed = this.#sessions.get(event.sessionID)
        this.#sessions.delete(event.sessionID)
        this.#unverifiedSessions.delete(event.sessionID)
        this.#snapshotOrder = undefined
        this.#historyNeedsPrune = true
        this.#completionPending.delete(event.sessionID)
        if (rootID === event.sessionID) this.#failedRoots.delete(rootID)
        if (removed?.permission) this.#permissionVersions.delete(removed.permission.id)
        return [
          { type: "session.remove", sessionID: event.sessionID },
          ...this.#maybeComplete(rootID),
        ]
      }
      case "session.status": {
        const session = this.#ensure(event.sessionID)
        if (session.status !== event.status) this.#historyNeedsPrune = true
        const root = this.#rootID(session.id)
        const startsCycle =
          (event.status === "busy" || event.status === "retry") && !this.#isTreeActive(root)
        const cleared = startsCycle ? this.#clearErrors(root, session.id) : []
        if (startsCycle) this.#failedRoots.delete(root)
        session.status = event.status
        session.updatedAt = this.#now()
        if (event.status === "retry") {
          session.retry = event.retry ?? { attempt: 0, message: "Retrying" }
        } else {
          delete session.retry
        }
        if (event.status === "busy" || event.status === "retry") {
          delete session.error
          this.#completionPending.add(root)
          return [...cleared, this.#upsert(session)]
        }
        return [this.#upsert(session), ...this.#maybeComplete(this.#rootID(session.id))]
      }
      case "session.idle": {
        const session = this.#ensure(event.sessionID)
        if (session.status !== "idle" || session.activity) this.#historyNeedsPrune = true
        session.status = "idle"
        delete session.retry
        delete session.activity
        session.updatedAt = this.#now()
        return [this.#upsert(session), ...this.#maybeComplete(this.#rootID(session.id))]
      }
      case "session.error": {
        const session = this.#ensure(event.sessionID)
        session.error = event.message
        session.updatedAt = this.#now()
        this.#failedRoots.add(this.#rootID(session.id))
        return [
          this.#upsert(session),
          {
            type: "notify",
            event: {
              kind: "error",
              sessionID: session.id,
              title: session.title,
              message: event.message,
              createdAt: this.#now(),
            },
          },
        ]
      }
      case "todo.updated": {
        const session = this.#ensure(event.sessionID)
        session.todos = todoSummary(event.todos)
        session.updatedAt = this.#now()
        return [this.#upsert(session)]
      }
      case "tool.updated": {
        const session = this.#ensure(event.sessionID)
        const active = event.status === "pending" || event.status === "running"
        const root = this.#rootID(session.id)
        const startsCycle = active && !this.#isTreeActive(root)
        if (!!session.activity !== active) this.#historyNeedsPrune = true
        const cleared = startsCycle ? this.#clearErrors(root, session.id) : []
        if (startsCycle) this.#failedRoots.delete(root)
        if (active) {
          session.activity = {
            tool: event.tool,
            ...(event.detail ? { detail: event.detail } : {}),
            since: this.#now(),
          }
          if (session.status !== "retry") session.status = "busy"
          delete session.error
          this.#completionPending.add(root)
        } else if (session.activity?.tool === event.tool) {
          delete session.activity
        }
        session.updatedAt = this.#now()
        return [...cleared, this.#upsert(session)]
      }
      case "permission.asked": {
        const session = this.#ensure(event.permission.sessionID)
        this.#historyNeedsPrune = true
        if (session.permission && session.permission.id !== event.permission.id) {
          this.#permissionVersions.delete(session.permission.id)
        }
        const createdAt = event.permission.createdAt ?? this.#now()
        session.permission = {
          id: event.permission.id,
          title: event.permission.title,
          patterns: [...event.permission.patterns],
          createdAt,
        }
        session.updatedAt = this.#now()
        this.#permissionVersions.set(event.permission.id, event.permission.version)
        return [
          this.#upsert(session),
          {
            type: "notify",
            event: {
              kind: "permission",
              sessionID: session.id,
              title: event.permission.title,
              ...(event.permission.patterns.length > 0
                ? { message: event.permission.patterns.join(", ") }
                : {}),
              createdAt,
            },
          },
        ]
      }
      case "permission.replied": {
        const response = asPermissionResponse(event.response)
        const mutations = this.resolvePermission(event.sessionID, event.permissionID)
        mutations.push({
          type: "permission.replied",
          sessionID: event.sessionID,
          permissionID: event.permissionID,
          response,
          ok: true,
        })
        return mutations
      }
      case "question.asked": {
        const session = this.#ensure(event.sessionID)
        session.updatedAt = this.#now()
        return [
          this.#upsert(session),
          {
            type: "notify",
            event: {
              kind: "question",
              sessionID: session.id,
              title: event.title ?? "Question",
              createdAt: this.#now(),
            },
          },
        ]
      }
      case "question.resolved":
        return []
    }
  }

  #ensure(sessionID: string): SessionState {
    const existing = this.#sessions.get(sessionID)
    if (existing) return existing
    const session: SessionState = {
      id: sessionID,
      title: "OpenCode",
      directory: this.#directory,
      status: "idle",
      todos: { total: 0, completed: 0 },
      updatedAt: this.#now(),
    }
    this.#sessions.set(sessionID, session)
    // Once old projections have been trimmed, a status/tool-only event could
    // refer to a former child whose parent metadata is no longer available.
    // Do not invent a root completion until a session metadata event arrives.
    if (this.#hasPrunedHistory) this.#unverifiedSessions.add(sessionID)
    this.#historyNeedsPrune = true
    this.#snapshotOrder = undefined
    return session
  }

  #upsert(session: SessionState): StoreMutation {
    this.#snapshotOrder = undefined
    return { type: "session.upsert", session: cloneSession(session) }
  }

  #pruneHistory(): StoreMutation[] {
    if (!this.#historyNeedsPrune) return []
    this.#historyNeedsPrune = false
    if (this.#sessions.size <= MAX_HISTORY_SESSIONS) return []
    const protectedIDs = new Set<string>()
    for (const session of this.#sessions.values()) {
      const rootID = this.#rootID(session.id)
      // A pending cycle may still need an idle child's parent/error relation.
      // Keep its whole tree until completion is resolved, in addition to the
      // ancestors of every active or waiting session.
      if (this.#completionPending.has(rootID) || this.#completionPending.has(session.id)) {
        protectedIDs.add(session.id)
      }
      if (session.status !== "busy" && session.status !== "retry" && !session.activity && !session.permission) continue
      let current: SessionState | undefined = session
      const ancestors = new Set<string>()
      while (current && !ancestors.has(current.id)) {
        ancestors.add(current.id)
        protectedIDs.add(current.id)
        current = current.parentID ? this.#sessions.get(current.parentID) : undefined
      }
    }
    const history = [...this.#sessions.values()]
      .filter((session) => !protectedIDs.has(session.id))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    const mutations: StoreMutation[] = []
    for (const session of history.slice(MAX_HISTORY_SESSIONS)) {
      this.#sessions.delete(session.id)
      this.#unverifiedSessions.delete(session.id)
      this.#completionPending.delete(session.id)
      this.#failedRoots.delete(session.id)
      if (session.permission) this.#permissionVersions.delete(session.permission.id)
      mutations.push({ type: "session.remove", sessionID: session.id })
    }
    if (mutations.length > 0) {
      this.#snapshotOrder = undefined
      this.#hasPrunedHistory = true
    }
    return mutations
  }

  #rootID(sessionID: string): string {
    let current = sessionID
    const visited = new Set<string>()
    while (!visited.has(current)) {
      visited.add(current)
      const parent = this.#sessions.get(current)?.parentID
      if (!parent) return current
      current = parent
    }
    return sessionID
  }

  #hasActiveDescendant(rootID: string): boolean {
    for (const session of this.#sessions.values()) {
      if (session.id === rootID || this.#rootID(session.id) !== rootID) continue
      if (session.status === "busy" || session.status === "retry" || session.activity) return true
    }
    return false
  }

  #hasPendingPermission(rootID: string): boolean {
    for (const session of this.#sessions.values()) {
      if (!session.permission) continue
      if (session.id === rootID || this.#rootID(session.id) === rootID) return true
    }
    return false
  }

  #isTreeActive(rootID: string): boolean {
    for (const session of this.#sessions.values()) {
      if (session.id !== rootID && this.#rootID(session.id) !== rootID) continue
      if (session.status === "busy" || session.status === "retry" || session.activity) return true
    }
    return false
  }

  #clearErrors(rootID: string, laterUpsertID: string): StoreMutation[] {
    const mutations: StoreMutation[] = []
    for (const session of this.#sessions.values()) {
      if (!session.error) continue
      if (session.id !== rootID && this.#rootID(session.id) !== rootID) continue
      delete session.error
      session.updatedAt = this.#now()
      if (session.id !== laterUpsertID) mutations.push(this.#upsert(session))
    }
    return mutations
  }

  #maybeComplete(rootID: string): StoreMutation[] {
    const root = this.#sessions.get(rootID)
    if (
      !root ||
      root.parentID ||
      root.status !== "idle" ||
      !this.#completionPending.has(rootID) ||
      this.#hasActiveDescendant(rootID) ||
      this.#hasPendingPermission(rootID)
    ) {
      return []
    }
    this.#completionPending.delete(rootID)
    this.#historyNeedsPrune = true
    if (this.#failedRoots.has(rootID) || this.#unverifiedSessions.has(rootID)) return []
    return [
      {
        type: "notify",
        event: {
          kind: "task_done",
          sessionID: root.id,
          title: root.title,
          createdAt: this.#now(),
        },
      },
    ]
  }
}
