import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_NOTIFICATIONS, DEFAULT_SHORTCUTS } from "../src/shared/ipc"
import { SettingsStore, parseSettingsUpdate } from "../src/main/settings"
import { ShortcutController } from "../src/main/shortcuts"
import { NotificationController, type PetAlert } from "../src/main/notifications"

describe("preferences and migration", () => {
  test("failed persistence keeps old in-memory shortcuts and subsequent writes serialize cleanly", async () => {
    let rejectSave = true
    const saved: unknown[] = []
    const store = new SettingsStore("unused-test-settings.json", async (settings) => {
      if (rejectSave) throw new Error("simulated disk failure")
      saved.push(settings)
    })
    const before = store.get()
    await expect(store.update({ shortcuts: { toggle: "Ctrl+New", tasks: "" } })).rejects.toThrow("disk failure")
    expect(store.get()).toEqual(before)
    rejectSave = false
    await Promise.all([store.update({ locked: true }), store.setSkinPath("D:\\pet.json"), store.setWindowPosition({ x: 100, y: 200 })])
    expect(store.get()).toMatchObject({ locked: true, skinPath: "D:\\pet.json", windowPosition: { x: 100, y: 200 }, shortcuts: DEFAULT_SHORTCUTS })
    expect(saved).toHaveLength(3)
  })
  test("migrates 0.2 settings and persists new preferences without losing skin or coordinates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pet-settings-"))
    const file = join(directory, "settings.json")
    try {
      await writeFile(file, JSON.stringify({ scale: 1.2, clickThrough: false, skinPath: "D:\\pets\\boba\\pet.json", windowPosition: { x: 300, y: 400 } }))
      const store = new SettingsStore(file)
      await store.load()
      const migrated = store.get()
      expect(migrated.scale).toBe(1.2)
      expect(migrated.notifications).toEqual(DEFAULT_NOTIFICATIONS)
      expect(migrated.shortcuts).toEqual(DEFAULT_SHORTCUTS)
      await store.update({ locked: true, pinnedSessions: ["project/task"], taskPreferences: { project: "project", status: "busy", collapseCompleted: true } })
      const reloaded = new SettingsStore(file)
      await reloaded.load()
      expect(reloaded.get().locked).toBe(true)
      expect(reloaded.get().skinPath).toBe("D:\\pets\\boba\\pet.json")
      expect(reloaded.get().windowPosition).toEqual({ x: 300, y: 400 })
      expect(reloaded.get().pinnedSessions).toEqual(["project/task"])
      const copy = reloaded.get()
      copy.notifications.error.sound = false
      copy.pinnedSessions.push("unpersisted")
      expect(reloaded.get().notifications.error.sound).toBe(true)
      expect(reloaded.get().pinnedSessions).toEqual(["project/task"])
      expect(JSON.parse(await readFile(file, "utf8")).locked).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test("rejects invalid nested IPC settings and caps pin count", () => {
    expect(() => parseSettingsUpdate({ notifications: { error: { sound: "yes", popup: true } } })).toThrow()
    expect(() => parseSettingsUpdate({ shortcuts: { toggle: "Ctrl+P", tasks: "ctrl+p" } })).toThrow()
    expect(() => parseSettingsUpdate({ pinnedSessions: Array(101).fill("task") })).toThrow()
    expect(() => parseSettingsUpdate({ taskPreferences: { project: "", status: "invalid", collapseCompleted: true } })).toThrow()
    expect(() => parseSettingsUpdate({ dndUntil: Infinity })).toThrow()
    expect(parseSettingsUpdate({ shortcuts: { toggle: "", tasks: "" } })).toEqual({ shortcuts: { toggle: "", tasks: "" } })
    expect(parseSettingsUpdate({ pinnedSessions: ["task", "task"] })).toEqual({ pinnedSessions: ["task"] })
  })
})

describe("custom shortcut registration", () => {
  test("restores old shortcuts after conflict and unregisters on shutdown", () => {
    const registered = new Map<string, () => void>()
    let toggles = 0
    const controller = new ShortcutController({
      register(key, action) { if (key === "Ctrl+Blocked") return false; registered.set(key, action); return true },
      unregister(key) { registered.delete(key) },
    }, { toggle: () => toggles++, tasks: () => {} })
    controller.configure({ toggle: "Ctrl+P", tasks: "Ctrl+T" })
    expect(() => controller.configure({ toggle: "Ctrl+New", tasks: "Ctrl+Blocked" })).toThrow("占用")
    expect([...registered.keys()]).toEqual(["Ctrl+P", "Ctrl+T"])
    registered.get("Ctrl+P")!()
    expect(toggles).toBe(1)
    controller.configure({ toggle: "", tasks: "" })
    expect(registered.size).toBe(0)
    controller.configure({ toggle: "Ctrl+P", tasks: "Ctrl+T" })
    controller.dispose()
    expect(registered.size).toBe(0)
  })
})

describe("notification presentation policy", () => {
  const preferences = () => ({ notifications: structuredClone(DEFAULT_NOTIFICATIONS), dndUntil: 0, mergeNotifications: true })
  const done = (id: string) => ({ kind: "task_done" as const, sessionID: id, title: "完成", createdAt: Date.now() })

  test("merges bursts while permissions remain immediate, deduplicating retransmits", async () => {
    const settings = preferences()
    const alerts: PetAlert[] = []
    const controller = new NotificationController(() => settings, (alert) => alerts.push(alert), 25)
    try {
      for (let index = 0; index < 10; index++) controller.push("instance", "project", done(String(index)))
      const permission = { kind: "permission" as const, sessionID: "pending", title: "授权", createdAt: Date.now() }
      controller.push("instance", "project", permission)
      controller.push("instance", "project", permission)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.kind).toBe("permission")
      await Bun.sleep(45)
      expect(alerts).toHaveLength(2)
      expect(alerts[1]!.count).toBe(10)
      expect(alerts[1]!.title).toContain("10")
    } finally { controller.dispose() }
  })

  test("respects independent sound/popup flags and do-not-disturb at delivery time", async () => {
    const settings = preferences()
    const alerts: PetAlert[] = []
    const controller = new NotificationController(() => settings, (alert) => alerts.push(alert), 25)
    try {
      settings.notifications.permission = { sound: false, popup: true }
      controller.push("instance", "project", { ...done("p"), kind: "permission" })
      expect(alerts[0]).toMatchObject({ sound: false, popup: true })
      controller.push("instance", "project", done("pending"))
      settings.dndUntil = Date.now() + 60_000
      await Bun.sleep(45)
      expect(alerts).toHaveLength(1)
      controller.push("instance", "project", { ...done("quiet"), kind: "error" })
      expect(alerts).toHaveLength(1)
      settings.dndUntil = 0
      settings.mergeNotifications = false
      settings.notifications.error = { sound: true, popup: false }
      controller.push("instance", "project", { ...done("resumed"), kind: "error" })
      expect(alerts[1]).toMatchObject({ sound: true, popup: false, count: 1 })
    } finally { controller.dispose() }
  })

  test("cancels pending presentation on shutdown", async () => {
    const alerts: PetAlert[] = []
    const controller = new NotificationController(preferences, (alert) => alerts.push(alert), 20)
    controller.push("instance", "project", done("pending"))
    controller.dispose()
    await Bun.sleep(35)
    expect(alerts).toHaveLength(0)
  })
})
