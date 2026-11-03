import { describe, expect, test } from "bun:test"
import { SessionStore } from "../src/state"

describe("SessionStore", () => {
  test("notifies once when a root finishes and suppresses child completion", () => {
    let timestamp = 100
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.upsert", info: { id: "root", title: "Root" } })
    store.apply({ type: "session.upsert", info: { id: "child", parentID: "root", title: "Child" } })
    store.apply({ type: "session.status", sessionID: "root", status: "busy" })
    store.apply({ type: "session.status", sessionID: "child", status: "busy" })

    const premature = store.apply({ type: "session.status", sessionID: "root", status: "idle" })
    expect(premature.some((item) => item.type === "notify")).toBe(false)

    const completed = store.apply({ type: "session.idle", sessionID: "child" })
    expect(completed.filter((item) => item.type === "notify")).toEqual([
      {
        type: "notify",
        event: { kind: "task_done", sessionID: "root", title: "Root", createdAt: timestamp },
      },
    ])
    expect(store.apply({ type: "session.idle", sessionID: "child" }).some((item) => item.type === "notify")).toBe(false)
  })

  test("projects full todo arrays and permission lifecycle", () => {
    let timestamp = 1_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({
      type: "todo.updated",
      sessionID: "ses_1",
      todos: [
        { content: "Done", status: "completed" },
        { content: "Active", status: "in_progress" },
        { content: "Later", status: "pending" },
      ],
    })
    expect(store.get("ses_1")?.todos).toEqual({ total: 3, completed: 1, current: "Active" })

    const asked = store.apply({
      type: "permission.asked",
      permission: {
        id: "per_1",
        sessionID: "ses_1",
        title: "Shell",
        patterns: ["bun test"],
        version: "v2",
      },
    })
    expect(store.permissionVersion("per_1")).toBe("v2")
    expect(asked.some((item) => item.type === "notify" && item.event.kind === "permission")).toBe(true)
    expect(store.resolvePermission("ses_1", "per_1")).toHaveLength(1)
    expect(store.get("ses_1")?.permission).toBeUndefined()
  })

  test("tracks child-only activity but defers completion for a pending permission", () => {
    let timestamp = 2_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.upsert", info: { id: "root", title: "Root" } })
    store.apply({ type: "session.upsert", info: { id: "child", parentID: "root" } })
    store.apply({ type: "session.status", sessionID: "child", status: "busy" })
    store.apply({
      type: "permission.asked",
      permission: {
        id: "per_child",
        sessionID: "child",
        title: "External directory",
        patterns: ["/tmp/*"],
        version: "v2",
      },
    })

    const childIdle = store.apply({ type: "session.idle", sessionID: "child" })
    expect(childIdle.some((item) => item.type === "notify" && item.event.kind === "task_done")).toBe(false)

    const resolved = store.resolvePermission("child", "per_child")
    expect(resolved.filter((item) => item.type === "notify")).toEqual([
      {
        type: "notify",
        event: { kind: "task_done", sessionID: "root", title: "Root", createdAt: timestamp },
      },
    ])
  })

  test("does not report an errored task as successfully completed", () => {
    let timestamp = 3_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.status", sessionID: "root", status: "busy" })
    store.apply({ type: "session.error", sessionID: "root", message: "boom" })

    const idle = store.apply({ type: "session.idle", sessionID: "root" })
    expect(idle.some((item) => item.type === "notify" && item.event.kind === "task_done")).toBe(false)
  })

  test("allows a later clean activity cycle to complete after an earlier child error", () => {
    let timestamp = 3_500
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.upsert", info: { id: "root", title: "Root" } })
    store.apply({ type: "session.upsert", info: { id: "child", parentID: "root" } })
    store.apply({ type: "session.status", sessionID: "child", status: "busy" })
    store.apply({ type: "session.error", sessionID: "child", message: "first attempt failed" })
    store.apply({ type: "session.idle", sessionID: "child" })
    expect(store.apply({ type: "session.idle", sessionID: "root" }).some((item) => item.type === "notify" && item.event.kind === "task_done")).toBe(false)

    const restarted = store.apply({ type: "session.status", sessionID: "root", status: "busy" })
    expect(store.get("child")?.error).toBeUndefined()
    expect(restarted.some((item) => item.type === "session.upsert" && item.session.id === "child")).toBe(true)
    expect(store.apply({ type: "session.idle", sessionID: "root" }).some((item) => item.type === "notify" && item.event.kind === "task_done")).toBe(true)
  })

  test("finishes an idle root when its last active child is removed", () => {
    let timestamp = 4_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.upsert", info: { id: "root", title: "Root" } })
    store.apply({ type: "session.upsert", info: { id: "child", parentID: "root" } })
    store.apply({ type: "session.status", sessionID: "child", status: "busy" })
    store.apply({ type: "session.idle", sessionID: "root" })

    const removed = store.apply({ type: "session.remove", sessionID: "child" })
    expect(removed.some((item) => item.type === "notify" && item.event.kind === "task_done")).toBe(true)
  })

  test("keeps only 200 inactive history sessions and emits cache removals", () => {
    let timestamp = 10_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    let removed = 0
    const started = performance.now()
    for (let index = 0; index < 1_000; index += 1) {
      removed += store.apply({ type: "session.upsert", info: { id: `history-${index}` } })
        .filter((mutation) => mutation.type === "session.remove").length
    }
    expect(store.snapshot()).toHaveLength(200)
    expect(removed).toBe(800)
    expect(store.get("history-0")).toBeUndefined()
    expect(store.get("history-999")).toBeDefined()
    const snapshot = store.snapshot()
    snapshot[0]!.todos.total = 999
    expect(store.snapshot()[0]?.todos.total).toBe(0)
    console.info(`SessionStore history: 1000 sessions -> 200 retained in ${Math.round(performance.now() - started)} ms`)
  })

  test("protects active, retry and permission ancestry plus pending cycle relations", () => {
    let timestamp = 20_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.upsert", info: { id: "root" } })
    store.apply({ type: "session.upsert", info: { id: "branch", parentID: "root" } })
    store.apply({ type: "session.upsert", info: { id: "active", parentID: "branch" } })
    store.apply({ type: "session.upsert", info: { id: "idle-sibling", parentID: "root" } })
    store.apply({ type: "session.status", sessionID: "active", status: "busy" })
    store.apply({ type: "session.status", sessionID: "retry", status: "retry" })
    store.apply({ type: "session.upsert", info: { id: "permission-parent" } })
    store.apply({ type: "session.upsert", info: { id: "waiting", parentID: "permission-parent" } })
    store.apply({ type: "permission.asked", permission: { id: "permission", sessionID: "waiting", title: "Shell", patterns: [], version: "v2" } })
    for (let index = 0; index < 300; index += 1) {
      store.apply({ type: "session.upsert", info: { id: `history-${index}` } })
    }
    for (const id of ["root", "branch", "active", "idle-sibling", "retry", "permission-parent", "waiting"]) {
      expect(store.get(id)).toBeDefined()
    }
    expect(store.snapshot()).toHaveLength(207)
    expect(store.permissionVersion("permission")).toBe("v2")
    const finished = store.apply({ type: "session.idle", sessionID: "active" })
    expect(finished.some((mutation) => mutation.type === "notify" && mutation.event.sessionID === "root")).toBe(true)
    expect(store.snapshot()).toHaveLength(203)
  })

  test("failed completed cycles do not hold history forever or send success", () => {
    let timestamp = 30_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    for (let index = 0; index < 300; index += 1) {
      const sessionID = `failed-${index}`
      store.apply({ type: "session.status", sessionID, status: "busy" })
      store.apply({ type: "session.error", sessionID, message: "failure" })
      const idle = store.apply({ type: "session.idle", sessionID })
      expect(idle.some((mutation) => mutation.type === "notify")).toBe(false)
    }
    expect(store.snapshot()).toHaveLength(200)
    store.apply({ type: "session.upsert", info: { id: "failed-299" } })
    store.apply({ type: "session.status", sessionID: "failed-299", status: "busy" })
    expect(store.apply({ type: "session.idle", sessionID: "failed-299" })
      .some((mutation) => mutation.type === "notify" && mutation.event.kind === "task_done")).toBe(true)
  })

  test("replacing a waiting permission releases its old API-version entry", () => {
    const store = new SessionStore({ directory: "/repo" })
    for (const id of ["old", "new"]) {
      store.apply({ type: "permission.asked", permission: { id, sessionID: "waiting", title: "Shell", patterns: [], version: "v2" } })
    }
    expect(store.permissionVersion("old")).toBeUndefined()
    expect(store.permissionVersion("new")).toBe("v2")
  })

  test("a trimmed child revived only by status/tool events cannot masquerade as a completed root", () => {
    let timestamp = 40_000
    const store = new SessionStore({ directory: "/repo", now: () => ++timestamp })
    store.apply({ type: "session.upsert", info: { id: "root" } })
    store.apply({ type: "session.upsert", info: { id: "child", parentID: "root" } })
    for (let index = 0; index < 250; index += 1) {
      store.apply({ type: "session.upsert", info: { id: `history-${index}` } })
    }
    expect(store.get("child")).toBeUndefined()
    store.apply({ type: "tool.updated", sessionID: "child", tool: "shell", status: "running" })
    const idle = store.apply({ type: "session.idle", sessionID: "child" })
    expect(idle.some((mutation) => mutation.type === "notify" && mutation.event.kind === "task_done")).toBe(false)
    for (let index = 250; index < 500; index += 1) {
      store.apply({ type: "session.upsert", info: { id: `history-${index}` } })
    }
    expect(store.snapshot()).toHaveLength(200)
    expect(store.get("child")).toBeUndefined()

    // Metadata arriving during a revived cycle restores its real root and
    // migrates the provisional completion marker instead of losing the task.
    store.apply({ type: "session.status", sessionID: "child", status: "busy" })
    store.apply({ type: "session.upsert", info: { id: "root", title: "Real root" } })
    store.apply({ type: "session.upsert", info: { id: "child", parentID: "root" } })
    const completed = store.apply({ type: "session.idle", sessionID: "child" })
    expect(completed.filter((mutation) => mutation.type === "notify" && mutation.event.kind === "task_done"))
      .toEqual([{ type: "notify", event: { kind: "task_done", sessionID: "root", title: "Real root", createdAt: timestamp } }])
  })
})
