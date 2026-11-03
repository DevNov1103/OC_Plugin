import { describe, expect, test } from "bun:test"
import { DEFAULT_NOTIFICATIONS } from "../src/shared/ipc"
import { normalizeClientSettings, notificationPreferences } from "../src/renderer/settings-view"

describe("client settings compatibility", () => {
  test("older settings gain usable filters, notification defaults and gestures", () => {
    const settings = normalizeClientSettings({ scale: 1.2, autostart: true })
    expect(settings.autoLaunch).toBe(true)
    expect(settings.locked).toBe(false)
    expect(settings.inertia).toBe(true)
    expect(settings.lowPower).toBe(false)
    expect(settings.pinnedSessions).toEqual([])
    expect(settings.taskPreferences?.collapseCompleted).toBe(true)
    expect(settings.notifications).toEqual(DEFAULT_NOTIFICATIONS)
  })

  test("explicitly disabled preferences survive normalization", () => {
    const settings = normalizeClientSettings({ inertia: false, mergeNotifications: false,
      shortcuts: { toggle: "", tasks: "" }, locked: true })
    expect(settings.inertia).toBe(false)
    expect(settings.mergeNotifications).toBe(false)
    expect(settings.shortcuts).toEqual({ toggle: "", tasks: "" })
    expect(settings.locked).toBe(true)
  })

  test("notification controls do not mutate shared defaults", () => {
    const rules = notificationPreferences()
    rules.permission.popup = false
    expect(DEFAULT_NOTIFICATIONS.permission.popup).toBe(true)
    expect(notificationPreferences(rules).permission.popup).toBe(false)
  })
})
