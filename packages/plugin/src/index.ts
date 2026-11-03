import { randomBytes } from "node:crypto"
import type { ServerMessage } from "@opencode-pet/protocol"
import { publishDiscovery, type DiscoveryLease } from "./discovery"
import { normalizeOpenCodeEvent } from "./normalize"
import { replyPermission, replyQuestion, type OpenCodeReplyContext } from "./replies"
import { createBridgeServer, type BridgeServer } from "./server"
import { SessionStore, type StoreMutation } from "./state"

export { discoveryPath, publishDiscovery, DISCOVERY_DIRECTORY } from "./discovery"
export { normalizeOpenCodeEvent } from "./normalize"
export type { NormalizedEvent, PermissionApiVersion } from "./normalize"
export { replyPermission, replyQuestion } from "./replies"
export type { OpenCodeReplyContext, PermissionReplyRequest } from "./replies"
export { createBridgeServer } from "./server"
export type { BridgeServer, BridgeServerOptions } from "./server"
export { SessionStore } from "./state"
export type { SessionStoreOptions, StoreMutation } from "./state"

type UnknownRecord = Record<string, unknown>

export interface StructuralPluginInput {
  client?: unknown
  serverUrl?: unknown
  directory?: unknown
  worktree?: unknown
}

export interface PluginRuntime {
  event(input: unknown): Promise<void>
  dispose(): Promise<void>
}

export interface PluginRuntimeHandle {
  hooks: PluginRuntime
  bridge: BridgeServer
  discovery: DiscoveryLease
  store: SessionStore
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function urlValue(value: unknown): string {
  if (value instanceof URL) return value.href
  return stringValue(value) ?? "http://127.0.0.1"
}

function publishMutation(bridge: BridgeServer, mutation: StoreMutation): void {
  bridge.broadcast(mutation as ServerMessage)
}

/**
 * Starts the runtime behind the default export. Kept public for integration
 * tests; the input remains structural so SDK declarations are never runtime
 * authority.
 */
export async function startOpenCodePetPlugin(input: unknown): Promise<PluginRuntimeHandle> {
  const source = record(input) ?? {}
  const directory = stringValue(source.directory) ?? process.cwd()
  const worktree = stringValue(source.worktree) ?? directory
  const serverUrl = urlValue(source.serverUrl)
  const replyContext: OpenCodeReplyContext = {
    serverUrl,
    directory,
    worktree,
    ...(source.client !== undefined ? { client: source.client } : {}),
  }
  const store = new SessionStore({ directory })
  const token = randomBytes(32).toString("base64url")

  let bridge!: BridgeServer
  bridge = createBridgeServer({
    token,
    snapshot: () => store.snapshot(),
    async onPermissionReply(message) {
      const version = store.permissionVersion(message.permissionID)
      await replyPermission(replyContext, {
        sessionID: message.sessionID,
        permissionID: message.permissionID,
        response: message.response,
        ...(version ? { version } : {}),
      })
      for (const mutation of store.resolvePermission(message.sessionID, message.permissionID)) {
        publishMutation(bridge, mutation)
      }
    },
    async onQuestionReply(message) {
      await replyQuestion(replyContext, message)
    },
  })

  let discovery: DiscoveryLease
  try {
    discovery = await publishDiscovery({
      pid: process.pid,
      port: bridge.port,
      token,
      serverUrl,
      directory,
      worktree,
      startedAt: Date.now(),
    })
  } catch (error) {
    await bridge.stop()
    throw error
  }

  let disposed = false
  const hooks: PluginRuntime = {
    async event(payload) {
      if (disposed) return
      const event = normalizeOpenCodeEvent(payload)
      if (!event) return
      for (const mutation of store.apply(event)) publishMutation(bridge, mutation)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await discovery.dispose()
      await bridge.stop()
    },
  }
  return { hooks, bridge, discovery, store }
}

/** OpenCode-compatible plugin entrypoint. */
export default async function openCodePet(input: unknown): Promise<PluginRuntime> {
  return (await startOpenCodePetPlugin(input)).hooks
}
