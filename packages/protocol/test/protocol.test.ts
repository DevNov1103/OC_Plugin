import { describe, expect, test } from "bun:test"
import {
  decodeClientMessage,
  decodeServerMessage,
  isDiscoveryRecord,
  isSessionState,
  type SessionState,
} from "../src/index"

const session: SessionState = {
  id: "ses_1",
  title: "Build the pet",
  directory: "D:/work",
  status: "busy",
  todos: { total: 2, completed: 1, current: "Tests" },
  updatedAt: 1,
}

describe("protocol guards", () => {
  test("accepts a complete session and rejects malformed nested fields", () => {
    expect(isSessionState(session)).toBe(true)
    expect(isSessionState({ ...session, todos: { total: 1, completed: 2 } })).toBe(false)
    expect(isSessionState({ ...session, activity: { tool: "bash", since: Number.NaN } })).toBe(false)
  })

  test("decodes client frames without throwing", () => {
    expect(
      decodeClientMessage(
        JSON.stringify({
          type: "permission.reply",
          sessionID: "ses_1",
          permissionID: "per_1",
          response: "once",
        }),
      ),
    ).toEqual({
      type: "permission.reply",
      sessionID: "ses_1",
      permissionID: "per_1",
      response: "once",
    })
    expect(decodeClientMessage("{")) .toBeUndefined()
    expect(decodeClientMessage({ type: "permission.reply", response: "yes" })).toBeUndefined()
  })

  test("validates server snapshots", () => {
    expect(decodeServerMessage(JSON.stringify({ type: "snapshot", sessions: [session] }))).toBeDefined()
    expect(decodeServerMessage(new TextEncoder().encode(JSON.stringify({ type: "snapshot", sessions: [session] })))).toEqual({ type: "snapshot", sessions: [session] })
    expect(decodeServerMessage(JSON.stringify({ type: "snapshot", sessions: [null] }))).toBeUndefined()
  })

  test("requires an HTTP OpenCode URL and a substantial token", () => {
    expect(
      isDiscoveryRecord({
        pid: 1,
        port: 4123,
        token: "a".repeat(64),
        serverUrl: "http://127.0.0.1:4096",
        directory: "D:/work",
        worktree: "D:/work",
        startedAt: Date.now(),
      }),
    ).toBe(true)
    expect(
      isDiscoveryRecord({
        pid: 1,
        port: 4123,
        token: "short",
        serverUrl: "ws://127.0.0.1:4096",
        directory: "D:/work",
        worktree: "D:/work",
        startedAt: Date.now(),
      }),
    ).toBe(false)
    expect(
      isDiscoveryRecord({
        pid: 1,
        port: 0,
        token: "a".repeat(64),
        serverUrl: "http://127.0.0.1:4096",
        directory: "D:/work",
        worktree: "D:/work",
        startedAt: Date.now(),
      }),
    ).toBe(false)
  })
})
