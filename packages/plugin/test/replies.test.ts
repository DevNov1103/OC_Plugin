import { describe, expect, test } from "bun:test"
import { replyPermission } from "../src/replies"

describe("replyPermission", () => {
  test("uses the v2 HTTP route from the plan first", async () => {
    const calls: Array<{ url: string; body: string }> = []
    await replyPermission(
      {
        serverUrl: "http://127.0.0.1:4096/base",
        fetchImpl: (async (input, init) => {
          calls.push({ url: String(input), body: String(init?.body) })
          return new Response("true", { status: 200 })
        }) as typeof fetch,
      },
      { sessionID: "ses a", permissionID: "per/b", response: "once", version: "v2" },
    )
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4096/permission/per%2Fb/reply",
        body: JSON.stringify({ reply: "once" }),
      },
    ])
  })

  test("uses the legacy session route for a v1 request", async () => {
    const urls: string[] = []
    await replyPermission(
      {
        serverUrl: "http://localhost:4096",
        fetchImpl: (async (input) => {
          urls.push(String(input))
          return new Response("true", { status: 200 })
        }) as typeof fetch,
      },
      { sessionID: "ses_1", permissionID: "per_1", response: "always", version: "v1" },
    )
    expect(new URL(urls[0]!).pathname).toBe("/session/ses_1/permissions/per_1")
  })

  test("falls back to a structural SDK client", async () => {
    let argument: unknown
    await replyPermission(
      {
        client: {
          permission: {
            reply(value: unknown) {
              argument = value
              return Promise.resolve({ data: true })
            },
          },
        },
      },
      { sessionID: "ses_1", permissionID: "per_1", response: "reject" },
    )
    expect(argument).toEqual({ requestID: "per_1", reply: "reject" })
  })
})
