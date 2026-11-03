import { describe, expect, test } from "bun:test"
import { DEFAULT_TASK_PREFERENCES } from "../src/shared/ipc"
import { isRunningTask, persistentTaskKey, projectLabel, selectTaskPage, type TaskItem } from "../src/renderer/task-view"

function task(index: number, overrides: Partial<TaskItem> = {}): TaskItem {
  return { key: `instance:${index}`, pinKey: persistentTaskKey("D:\\work", String(index)), project: "D:\\work",
    priority: 2, updatedAt: index, busy: true, permission: false, error: false, completed: false, ...overrides }
}

describe("task filtering and paging", () => {
  test("retrying sessions and idle sessions with tool activity remain running", () => {
    expect(isRunningTask({ status: "retry" })).toBe(true)
    expect(isRunningTask({ status: "reconnecting" })).toBe(true)
    expect(isRunningTask({ status: "idle", activity: { tool: "bash" } })).toBe(true)
    expect(isRunningTask({ status: "idle" })).toBe(false)
    expect(isRunningTask({ status: "idle", activity: { tool: "  " } })).toBe(false)
    const liveActivity = task(1, { busy: isRunningTask({ status: "idle", activity: { tool: "read" } }), completed: false })
    const retry = task(2, { busy: isRunningTask({ status: "retry" }), completed: false })
    const page = selectTaskPage([liveActivity, retry], { ...DEFAULT_TASK_PREFERENCES, status: "busy" }, new Set())
    expect(page.active).toHaveLength(2)
    expect(page.completedCount).toBe(0)
  })

  test("persistent pins depend on project and session, not changing instance ids", () => {
    const key = persistentTaskKey('D:\\project [a]', 'session:1')
    expect(JSON.parse(key)).toEqual(['D:\\project [a]', 'session:1'])
    const first = task(1, { pinKey: key, updatedAt: 0 })
    const restarted = { ...first, key: "new-process:1" }
    const page = selectTaskPage([task(2), restarted], DEFAULT_TASK_PREFERENCES, new Set([key]))
    expect(page.active[0]?.key).toBe("new-process:1")
  })

  test("combines project and status filters while keeping permissions first", () => {
    const busy = task(1)
    const permission = task(2, { permission: true, busy: false, priority: 4 })
    const error = task(3, { error: true, busy: false, priority: 3 })
    const otherProject = task(4, { project: "D:\\other", permission: true, priority: 4 })
    const page = selectTaskPage([busy, error, permission, otherProject], { ...DEFAULT_TASK_PREFERENCES, project: "D:\\work", status: "permission" }, new Set())
    expect(page.active.map((item) => item.key)).toEqual([permission.key])
    const all = selectTaskPage([busy, error, permission], DEFAULT_TASK_PREFERENCES, new Set())
    expect(all.active.map((item) => item.key)).toEqual([permission.key, error.key, busy.key])
  })

  test("collapsed history does not allocate cards, while pinned completed tasks stay visible", () => {
    const idle = task(1, { busy: false, completed: true, priority: 1 })
    const pinned = task(2, { busy: false, completed: true, priority: 1 })
    const page = selectTaskPage([idle, pinned], DEFAULT_TASK_PREFERENCES, new Set([pinned.pinKey]))
    expect(page.active).toEqual([pinned])
    expect(page.completed).toHaveLength(0)
    expect(page.completedCount).toBe(1)
    const expanded = selectTaskPage([idle, pinned], { ...DEFAULT_TASK_PREFERENCES, collapseCompleted: false }, new Set([pinned.pinKey]))
    expect(expanded.completed).toEqual([idle])
  })

  test("bounds mounted cards to a shared 50-card page even with hundreds of sessions", () => {
    const active = Array.from({ length: 35 }, (_, index) => task(index))
    const completed = Array.from({ length: 100 }, (_, index) => task(100 + index, { busy: false, completed: true, priority: 1 }))
    const page = selectTaskPage([...active, ...completed], { ...DEFAULT_TASK_PREFERENCES, collapseCompleted: false }, new Set())
    expect(page.active).toHaveLength(35)
    expect(page.completed).toHaveLength(15)
    expect(page.more).toBe(true)
    expect(page.matched).toBe(135)
  })

  test("project labels handle Windows and slash paths", () => {
    expect(projectLabel("D:\\workspace\\demo")).toBe("demo")
    expect(projectLabel("/workspace/demo/")).toBe("demo")
  })
})
