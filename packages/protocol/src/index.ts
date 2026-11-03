export const PROTOCOL_VERSION = 1 as const

export type SessionStatus = "idle" | "busy" | "retry"
export type PermissionResponse = "once" | "always" | "reject"
export type NotificationKind = "task_done" | "error" | "permission" | "question"

export interface RetryState {
  attempt: number
  message: string
}

export interface TodoSummary {
  total: number
  completed: number
  current?: string
}

export interface ActivityState {
  tool: string
  detail?: string
  since: number
}

export interface PermissionState {
  id: string
  title: string
  patterns: string[]
  createdAt: number
}

export interface SessionState {
  id: string
  parentID?: string
  title: string
  directory: string
  status: SessionStatus
  retry?: RetryState
  todos: TodoSummary
  activity?: ActivityState
  permission?: PermissionState
  error?: string
  updatedAt: number
}

export interface NotificationEvent {
  kind: NotificationKind
  sessionID: string
  title?: string
  message?: string
  createdAt: number
}

export interface DiscoveryRecord {
  pid: number
  port: number
  token: string
  serverUrl: string
  directory: string
  worktree: string
  startedAt: number
}

export interface AuthMessage {
  type: "auth"
  token: string
}

export interface PermissionReplyMessage {
  type: "permission.reply"
  sessionID: string
  permissionID: string
  response: PermissionResponse
}

export interface QuestionReplyMessage {
  type: "question.reply"
  sessionID: string
  requestID: string
  answers: string[][]
}

export interface AckMessage {
  type: "ack"
  messageID?: string
}

export interface PingMessage {
  type: "ping"
  nonce?: string
}

export interface PongMessage {
  type: "pong"
  nonce?: string
}

export type ClientMessage =
  | AuthMessage
  | PermissionReplyMessage
  | QuestionReplyMessage
  | AckMessage
  | PingMessage
  | PongMessage

export interface SnapshotMessage {
  type: "snapshot"
  sessions: SessionState[]
}

export interface SessionUpsertMessage {
  type: "session.upsert"
  session: SessionState
}

export interface SessionRemoveMessage {
  type: "session.remove"
  sessionID: string
}

export interface NotifyMessage {
  type: "notify"
  event: NotificationEvent
}

export interface PermissionRepliedMessage {
  type: "permission.replied"
  sessionID: string
  permissionID: string
  response: PermissionResponse
  ok: boolean
  error?: string
}

export type ServerMessage =
  | SnapshotMessage
  | SessionUpsertMessage
  | SessionRemoveMessage
  | NotifyMessage
  | PermissionRepliedMessage
  | AckMessage
  | PingMessage
  | PongMessage

export type WireMessage = ClientMessage | ServerMessage

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

export function isPermissionResponse(value: unknown): value is PermissionResponse {
  return value === "once" || value === "always" || value === "reject"
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return value === "idle" || value === "busy" || value === "retry"
}

export function isTodoSummary(value: unknown): value is TodoSummary {
  if (!isRecord(value)) return false
  if (!isNonNegativeInteger(value.total) || !isNonNegativeInteger(value.completed)) return false
  if ((value.completed as number) > (value.total as number)) return false
  return isOptionalString(value.current)
}

export function isActivityState(value: unknown): value is ActivityState {
  return (
    isRecord(value) &&
    typeof value.tool === "string" &&
    value.tool.length > 0 &&
    isOptionalString(value.detail) &&
    hasOnlyFiniteNumber(value.since)
  )
}

export function isPermissionState(value: unknown): value is PermissionState {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.title === "string" &&
    isStringArray(value.patterns) &&
    hasOnlyFiniteNumber(value.createdAt)
  )
}

export function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isOptionalString(value.parentID) ||
    typeof value.title !== "string" ||
    typeof value.directory !== "string" ||
    !isSessionStatus(value.status) ||
    !isTodoSummary(value.todos) ||
    !isOptionalString(value.error) ||
    !hasOnlyFiniteNumber(value.updatedAt)
  ) {
    return false
  }

  if (value.retry !== undefined) {
    if (
      !isRecord(value.retry) ||
      !isNonNegativeInteger(value.retry.attempt) ||
      typeof value.retry.message !== "string"
    ) {
      return false
    }
  }
  if (value.activity !== undefined && !isActivityState(value.activity)) return false
  if (value.permission !== undefined && !isPermissionState(value.permission)) return false
  return true
}

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  return (
    isRecord(value) &&
    (value.kind === "task_done" ||
      value.kind === "error" ||
      value.kind === "permission" ||
      value.kind === "question") &&
    typeof value.sessionID === "string" &&
    value.sessionID.length > 0 &&
    isOptionalString(value.title) &&
    isOptionalString(value.message) &&
    hasOnlyFiniteNumber(value.createdAt)
  )
}

export function isDiscoveryRecord(value: unknown): value is DiscoveryRecord {
  if (!isRecord(value)) return false
  let validServerUrl = false
  if (typeof value.serverUrl === "string") {
    try {
      const parsed = new URL(value.serverUrl)
      validServerUrl = parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      validServerUrl = false
    }
  }
  return (
    isNonNegativeInteger(value.pid) &&
    isNonNegativeInteger(value.port) &&
    (value.port as number) >= 1 &&
    (value.port as number) <= 65535 &&
    typeof value.token === "string" &&
    value.token.length >= 32 &&
    validServerUrl &&
    typeof value.directory === "string" &&
    typeof value.worktree === "string" &&
    hasOnlyFiniteNumber(value.startedAt)
  )
}

export function isAuthMessage(value: unknown): value is AuthMessage {
  return isRecord(value) && value.type === "auth" && typeof value.token === "string" && value.token.length > 0
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false
  switch (value.type) {
    case "auth":
      return isAuthMessage(value)
    case "permission.reply":
      return (
        typeof value.sessionID === "string" &&
        value.sessionID.length > 0 &&
        typeof value.permissionID === "string" &&
        value.permissionID.length > 0 &&
        isPermissionResponse(value.response)
      )
    case "question.reply":
      return (
        typeof value.sessionID === "string" &&
        value.sessionID.length > 0 &&
        typeof value.requestID === "string" &&
        value.requestID.length > 0 &&
        Array.isArray(value.answers) &&
        value.answers.every(isStringArray)
      )
    case "ack":
    case "ping":
    case "pong":
      return isOptionalString(value.messageID) && isOptionalString(value.nonce)
    default:
      return false
  }
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false
  switch (value.type) {
    case "snapshot":
      return Array.isArray(value.sessions) && value.sessions.every(isSessionState)
    case "session.upsert":
      return isSessionState(value.session)
    case "session.remove":
      return typeof value.sessionID === "string" && value.sessionID.length > 0
    case "notify":
      return isNotificationEvent(value.event)
    case "permission.replied":
      return (
        typeof value.sessionID === "string" &&
        value.sessionID.length > 0 &&
        typeof value.permissionID === "string" &&
        value.permissionID.length > 0 &&
        isPermissionResponse(value.response) &&
        typeof value.ok === "boolean" &&
        isOptionalString(value.error)
      )
    case "ack":
    case "ping":
    case "pong":
      return isOptionalString(value.messageID) && isOptionalString(value.nonce)
    default:
      return false
  }
}

export function parseJsonMessage(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (value instanceof ArrayBuffer) {
    return parseJsonMessage(new TextDecoder().decode(value))
  }
  if (ArrayBuffer.isView(value)) {
    return parseJsonMessage(new TextDecoder().decode(value))
  }
  if (isRecord(value)) return value
  return undefined
}

export function decodeClientMessage(value: unknown): ClientMessage | undefined {
  const parsed = parseJsonMessage(value)
  return isClientMessage(parsed) ? parsed : undefined
}

export function decodeServerMessage(value: unknown): ServerMessage | undefined {
  const parsed = parseJsonMessage(value)
  return isServerMessage(parsed) ? parsed : undefined
}

export function encodeMessage(message: WireMessage): string {
  return JSON.stringify(message)
}
