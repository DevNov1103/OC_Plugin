import { describe, expect, test } from "bun:test"
import { normalizeOpenCodeEvent } from "../src/normalize"

describe("normalizeOpenCodeEvent", () => {
  test("unwraps the plugin hook payload and reads session info", () => {
    expect(
      normalizeOpenCodeEvent({
        event: {
          type: "session.created",
          properties: { info: { id: "ses_child", parentID: "ses_root", title: "Worker", directory: "/repo" } },
        },
      }),
    ).toEqual({
      type: "session.upsert",
      info: { id: "ses_child", parentID: "ses_root", title: "Worker", directory: "/repo" },
    })
  })

  test("normalizes legacy and v2 permission requests", () => {
    expect(
      normalizeOpenCodeEvent({
        type: "permission.updated",
        properties: {
          id: "per_old",
          sessionID: "ses_1",
          title: "Run command",
          pattern: ["git status"],
          time: { created: 10 },
        },
      }),
    ).toEqual({
      type: "permission.asked",
      permission: {
        id: "per_old",
        sessionID: "ses_1",
        title: "Run command",
        patterns: ["git status"],
        createdAt: 10,
        version: "v1",
      },
    })

    expect(
      normalizeOpenCodeEvent({
        type: "permission.v2.asked",
        properties: {
          id: "per_new",
          sessionID: "ses_1",
          action: "external_directory",
          resources: ["/outside/*"],
        },
      }),
    ).toEqual({
      type: "permission.asked",
      permission: {
        id: "per_new",
        sessionID: "ses_1",
        title: "external_directory",
        patterns: ["/outside/*"],
        version: "v2",
      },
    })
  })

  test("tracks tool activity without exposing tool input", () => {
    expect(
      normalizeOpenCodeEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "ses_1",
            tool: "bash",
            state: { status: "running", input: { command: "bun test" } },
          },
        },
      }),
    ).toEqual({ type: "tool.updated", sessionID: "ses_1", tool: "bash", status: "running" })
    expect(normalizeOpenCodeEvent({ type: "message.part.updated", properties: { part: null } })).toBeUndefined()
  })
})
