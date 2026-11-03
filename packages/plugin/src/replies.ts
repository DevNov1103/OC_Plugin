import type { PermissionResponse, QuestionReplyMessage } from "@opencode-pet/protocol"
import type { PermissionApiVersion } from "./normalize"

type UnknownRecord = Record<string, unknown>

export interface OpenCodeReplyContext {
  client?: unknown
  serverUrl?: unknown
  directory?: string
  worktree?: string
  fetchImpl?: typeof fetch
}

export interface PermissionReplyRequest {
  sessionID: string
  permissionID: string
  response: PermissionResponse
  version?: PermissionApiVersion
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function baseUrl(value: unknown): URL | undefined {
  try {
    const url = value instanceof URL ? new URL(value.href) : typeof value === "string" ? new URL(value) : undefined
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined
    return url
  } catch {
    return undefined
  }
}

function resultError(value: unknown): unknown {
  const item = record(value)
  return item?.error
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function invoke(object: UnknownRecord | undefined, method: string, argument: unknown): Promise<boolean> {
  const candidate = object?.[method]
  if (typeof candidate !== "function") return false
  const result = await candidate.call(object, argument)
  const error = resultError(result)
  if (error !== undefined && error !== null) throw new Error(describeError(error))
  return true
}

async function postCandidates(
  context: OpenCodeReplyContext,
  candidates: Array<{ path: string; body: UnknownRecord }>,
  errors: string[],
): Promise<boolean> {
  const base = baseUrl(context.serverUrl)
  if (!base) return false
  const fetcher = context.fetchImpl ?? globalThis.fetch
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.path, base)
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(context.directory ? { "x-opencode-directory": encodeURIComponent(context.directory) } : {}),
          ...(context.worktree ? { "x-opencode-worktree": encodeURIComponent(context.worktree) } : {}),
        },
        body: JSON.stringify(candidate.body),
      })
      if (response.ok) return true
      errors.push(`${url.pathname}: HTTP ${response.status}`)
      if (response.status !== 404 && response.status !== 405 && response.status !== 501) break
    } catch (error) {
      errors.push(`${candidate.path}: ${describeError(error)}`)
      break
    }
  }
  return false
}

function permissionCandidates(request: PermissionReplyRequest): Array<{ path: string; body: UnknownRecord }> {
  const sessionID = encodeURIComponent(request.sessionID)
  const permissionID = encodeURIComponent(request.permissionID)
  const v2 = {
    path: `/api/session/${sessionID}/permission/${permissionID}/reply`,
    body: { reply: request.response },
  }
  const current = {
    path: `/permission/${permissionID}/reply`,
    body: { reply: request.response },
  }
  const v1 = {
    path: `/session/${sessionID}/permissions/${permissionID}`,
    body: { response: request.response },
  }
  return request.version === "v1" ? [v1, current, v2] : [current, v2, v1]
}

/** Replies through real HTTP first, then tolerates several SDK generations. */
export async function replyPermission(
  context: OpenCodeReplyContext,
  request: PermissionReplyRequest,
): Promise<void> {
  const errors: string[] = []
  if (await postCandidates(context, permissionCandidates(request), errors)) return

  const client = record(context.client)
  const permission = record(client?.permission)
  const sdkCandidates: Array<[UnknownRecord | undefined, string, unknown]> = [
    [
      permission,
      "reply",
      {
        requestID: request.permissionID,
        reply: request.response,
        ...(context.directory ? { directory: context.directory } : {}),
        ...(context.worktree ? { workspace: context.worktree } : {}),
      },
    ],
    [
      client,
      "postSessionIdPermissionsPermissionId",
      {
        path: { id: request.sessionID, permissionID: request.permissionID },
        body: { response: request.response },
      },
    ],
    [
      permission,
      "respond",
      {
        sessionID: request.sessionID,
        permissionID: request.permissionID,
        response: request.response,
      },
    ],
  ]
  for (const [target, method, argument] of sdkCandidates) {
    try {
      if (await invoke(target, method, argument)) return
    } catch (error) {
      errors.push(`SDK ${method}: ${describeError(error)}`)
    }
  }
  throw new Error(errors.length > 0 ? `Permission reply failed (${errors.join("; ")})` : "Permission reply is unsupported")
}

export async function replyQuestion(
  context: OpenCodeReplyContext,
  request: QuestionReplyMessage,
): Promise<void> {
  const sessionID = encodeURIComponent(request.sessionID)
  const requestID = encodeURIComponent(request.requestID)
  const errors: string[] = []
  if (
    await postCandidates(
      context,
      [
        {
          path: `/api/session/${sessionID}/question/request/${requestID}/reply`,
          body: { answers: request.answers },
        },
        {
          path: `/api/session/${sessionID}/question/${requestID}/reply`,
          body: { answers: request.answers },
        },
        { path: `/question/${requestID}/reply`, body: { answers: request.answers } },
      ],
      errors,
    )
  ) {
    return
  }

  const client = record(context.client)
  const question = record(client?.question)
  try {
    if (
      await invoke(question, "reply", {
        requestID: request.requestID,
        answers: request.answers,
        ...(context.directory ? { directory: context.directory } : {}),
        ...(context.worktree ? { workspace: context.worktree } : {}),
      })
    ) {
      return
    }
  } catch (error) {
    errors.push(`SDK: ${describeError(error)}`)
  }
  throw new Error(errors.length > 0 ? `Question reply failed (${errors.join("; ")})` : "Question reply is unsupported")
}
