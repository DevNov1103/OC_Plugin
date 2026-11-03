type UnknownRecord = Record<string, unknown>

export type PermissionApiVersion = "v1" | "v2"

export interface NormalizedSessionInfo {
  id: string
  parentID?: string
  title?: string
  directory?: string
}

export interface NormalizedPermission {
  id: string
  sessionID: string
  title: string
  patterns: string[]
  createdAt?: number
  version: PermissionApiVersion
}

export type NormalizedEvent =
  | { type: "session.upsert"; info: NormalizedSessionInfo }
  | { type: "session.remove"; sessionID: string }
  | {
      type: "session.status"
      sessionID: string
      status: "idle" | "busy" | "retry"
      retry?: { attempt: number; message: string }
    }
  | { type: "session.idle"; sessionID: string }
  | { type: "session.error"; sessionID: string; message: string }
  | { type: "todo.updated"; sessionID: string; todos: unknown[] }
  | {
      type: "tool.updated"
      sessionID: string
      tool: string
      status: string
      detail?: string
    }
  | { type: "permission.asked"; permission: NormalizedPermission }
  | {
      type: "permission.replied"
      sessionID: string
      permissionID: string
      response: string
      version: PermissionApiVersion
    }
  | { type: "question.asked"; sessionID: string; requestID: string; title?: string }
  | { type: "question.resolved"; sessionID: string; requestID: string }

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function errorMessage(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value
  if (value instanceof Error && value.message) return value.message
  const item = record(value)
  if (!item) return "Unknown OpenCode error"
  const direct = nonEmptyString(item.message)
  if (direct) return direct
  const data = record(item.data)
  const nested = data && nonEmptyString(data.message)
  if (nested) return nested
  return nonEmptyString(item.name) ?? "Unknown OpenCode error"
}

function sessionID(properties: UnknownRecord): string | undefined {
  return nonEmptyString(properties.sessionID) ?? nonEmptyString(properties.sessionId)
}

function normalizeSessionInfo(value: unknown): NormalizedSessionInfo | undefined {
  const info = record(value)
  if (!info) return undefined
  const id = nonEmptyString(info.id) ?? nonEmptyString(info.sessionID)
  if (!id) return undefined
  const result: NormalizedSessionInfo = { id }
  const parentID = nonEmptyString(info.parentID) ?? nonEmptyString(info.parentId)
  const title = typeof info.title === "string" ? info.title : undefined
  const directory = typeof info.directory === "string" ? info.directory : undefined
  if (parentID) result.parentID = parentID
  if (title !== undefined) result.title = title
  if (directory !== undefined) result.directory = directory
  return result
}

function normalizeStatus(value: unknown):
  | { status: "idle" | "busy" | "retry"; retry?: { attempt: number; message: string } }
  | undefined {
  const item = typeof value === "string" ? { type: value } : record(value)
  if (!item) return undefined
  const status = item.type
  if (status === "idle" || status === "busy") return { status }
  if (status !== "retry") return undefined
  return {
    status,
    retry: {
      attempt: Math.max(0, Math.trunc(finiteNumber(item.attempt) ?? 0)),
      message: typeof item.message === "string" ? item.message : "Retrying",
    },
  }
}

function permissionFrom(
  properties: UnknownRecord,
  version: PermissionApiVersion,
): NormalizedPermission | undefined {
  const id =
    nonEmptyString(properties.id) ??
    nonEmptyString(properties.requestID) ??
    nonEmptyString(properties.permissionID)
  const sid = sessionID(properties)
  if (!id || !sid) return undefined

  const action = nonEmptyString(properties.action) ?? nonEmptyString(properties.permission)
  const title = nonEmptyString(properties.title) ?? action ?? "Permission required"
  const patterns = [
    ...stringList(properties.patterns),
    ...stringList(properties.pattern),
    ...stringList(properties.resources),
  ]
  const time = record(properties.time)
  const createdAt = finiteNumber(properties.createdAt) ?? (time && finiteNumber(time.created))
  return {
    id,
    sessionID: sid,
    title,
    patterns: [...new Set(patterns)],
    version,
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

function firstQuestionTitle(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const question of value) {
    const item = record(question)
    const title = item && (nonEmptyString(item.header) ?? nonEmptyString(item.question))
    if (title) return title
  }
  return undefined
}

/**
 * Converts both legacy and current OpenCode event payloads into a small, checked
 * internal union. It deliberately accepts `unknown`: generated SDK types have
 * changed between OpenCode releases and must not be treated as runtime proof.
 */
export function normalizeOpenCodeEvent(input: unknown): NormalizedEvent | undefined {
  let event = record(input)
  if (!event) return undefined
  if (typeof event.type !== "string") {
    const wrapped = record(event.event)
    if (!wrapped) return undefined
    event = wrapped
  }

  const type = event.type
  if (typeof type !== "string") return undefined
  const properties = record(event.properties) ?? {}

  switch (type) {
    case "session.created":
    case "session.updated": {
      const info = normalizeSessionInfo(properties.info ?? properties.session ?? properties)
      return info ? { type: "session.upsert", info } : undefined
    }
    case "session.deleted": {
      const info = normalizeSessionInfo(properties.info ?? properties.session ?? properties)
      const id = info?.id ?? sessionID(properties)
      return id ? { type: "session.remove", sessionID: id } : undefined
    }
    case "session.status": {
      const id = sessionID(properties)
      const status = normalizeStatus(properties.status)
      return id && status ? { type: "session.status", sessionID: id, ...status } : undefined
    }
    case "session.idle": {
      const id = sessionID(properties)
      return id ? { type: "session.idle", sessionID: id } : undefined
    }
    case "session.error": {
      const id = sessionID(properties)
      return id ? { type: "session.error", sessionID: id, message: errorMessage(properties.error) } : undefined
    }
    case "todo.updated": {
      const id = sessionID(properties)
      return id && Array.isArray(properties.todos)
        ? { type: "todo.updated", sessionID: id, todos: properties.todos }
        : undefined
    }
    case "message.part.updated": {
      const part = record(properties.part)
      if (!part || part.type !== "tool") return undefined
      const id = nonEmptyString(part.sessionID) ?? sessionID(properties)
      const tool = nonEmptyString(part.tool)
      const state = record(part.state)
      const status = state && nonEmptyString(state.status)
      if (!id || !tool || !status) return undefined
      // Tool inputs and display titles can contain commands, paths, prompts, or
      // other private data. The default bridge therefore exposes the tool name
      // and lifecycle only; a future explicit opt-in may populate `detail`.
      return { type: "tool.updated", sessionID: id, tool, status }
    }
    case "permission.updated": {
      const permission = permissionFrom(properties, "v1")
      return permission ? { type: "permission.asked", permission } : undefined
    }
    case "permission.asked":
    case "permission.v2.asked": {
      const permission = permissionFrom(properties, "v2")
      return permission ? { type: "permission.asked", permission } : undefined
    }
    case "permission.replied":
    case "permission.v2.replied": {
      const id = sessionID(properties)
      const permissionID =
        nonEmptyString(properties.permissionID) ??
        nonEmptyString(properties.requestID) ??
        nonEmptyString(properties.id)
      const response =
        nonEmptyString(properties.response) ?? nonEmptyString(properties.reply) ?? "reject"
      if (!id || !permissionID) return undefined
      return {
        type: "permission.replied",
        sessionID: id,
        permissionID,
        response,
        version: type === "permission.v2.replied" ? "v2" : "v1",
      }
    }
    case "question.asked":
    case "question.v2.asked": {
      const id = sessionID(properties)
      const requestID = nonEmptyString(properties.id) ?? nonEmptyString(properties.requestID)
      if (!id || !requestID) return undefined
      const title = firstQuestionTitle(properties.questions)
      return { type: "question.asked", sessionID: id, requestID, ...(title ? { title } : {}) }
    }
    case "question.replied":
    case "question.rejected":
    case "question.v2.replied":
    case "question.v2.rejected": {
      const id = sessionID(properties)
      const requestID = nonEmptyString(properties.requestID) ?? nonEmptyString(properties.id)
      return id && requestID ? { type: "question.resolved", sessionID: id, requestID } : undefined
    }
    default:
      return undefined
  }
}
