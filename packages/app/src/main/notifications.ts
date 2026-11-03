import type { NotificationEvent } from "@opencode-pet/protocol"
import type { NotificationKind, PetSettings } from "../shared/ipc"

export interface PetAlert {
  kind: NotificationKind
  title: string
  message: string
  count: number
  sound: boolean
  popup: boolean
}
type Preferences = Pick<PetSettings, "notifications" | "dndUntil" | "mergeNotifications">
interface PendingAlert { kind: NotificationKind; label: string; event: NotificationEvent; count: number; timer: ReturnType<typeof setTimeout> }

const TITLES: Record<NotificationKind, string> = {
  task_done: "OpenCode 任务完成", error: "OpenCode 任务出错", permission: "OpenCode 等待授权", question: "OpenCode 等待回答",
}

/** Status events remain immediate. Only the sound/popup presentation is merged. */
export class NotificationController {
  private readonly pending = new Map<NotificationKind, PendingAlert>()
  private readonly recent = new Map<string, number>()
  constructor(private readonly settings: () => Preferences, private readonly present: (alert: PetAlert) => void, private readonly mergeDelayMs = 1_000) {}

  push(instanceID: string, label: string, event: NotificationEvent): void {
    const now = Date.now()
    for (const [key, at] of this.recent) if (now - at > 10_000) this.recent.delete(key)
    const key = JSON.stringify([instanceID, event.kind, event.sessionID, event.createdAt])
    if (this.recent.has(key)) return
    this.recent.set(key, now)
    while (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!)
    const preferences = this.settings()
    if (preferences.dndUntil > now) return
    if (!preferences.notifications[event.kind].sound && !preferences.notifications[event.kind].popup) return
    if (!preferences.mergeNotifications || event.kind === "permission" || event.kind === "question") {
      this.deliver(event.kind, label, event, 1)
      return
    }
    const existing = this.pending.get(event.kind)
    if (existing) {
      existing.count++
      existing.label = label
      existing.event = event
      return
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(event.kind)
      this.pending.delete(event.kind)
      if (pending) this.deliver(pending.kind, pending.label, pending.event, pending.count)
    }, this.mergeDelayMs)
    timer.unref?.()
    this.pending.set(event.kind, { kind: event.kind, label, event, count: 1, timer })
  }

  dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer)
    this.pending.clear()
    this.recent.clear()
  }

  private deliver(kind: NotificationKind, label: string, event: NotificationEvent, count: number): void {
    const preferences = this.settings()
    if (preferences.dndUntil > Date.now()) return
    const rule = preferences.notifications[kind]
    if (!rule.sound && !rule.popup) return
    this.present({
      kind, count, ...rule,
      title: count > 1 ? `${TITLES[kind]} · ${count} 项` : TITLES[kind],
      message: count > 1 ? `${count} 条${kind === "task_done" ? "完成" : "错误"}提醒；最新：${label} · ${event.message || event.title || "请查看任务面板"}` : `${label}：${event.message || event.title || "请查看任务面板"}`,
    })
  }
}
