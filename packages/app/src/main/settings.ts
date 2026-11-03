import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { DEFAULT_NOTIFICATIONS, DEFAULT_SHORTCUTS, DEFAULT_TASK_PREFERENCES, type PetSettings, type SettingsUpdate } from "../shared/ipc"

export interface WindowPosition {
  x: number
  y: number
}

export interface StoredSettings extends Omit<PetSettings, "skin" | "skinPath" | "shortcutError"> {
  skinPath: string | null
  windowPosition: WindowPosition | null
}

const DEFAULT_SETTINGS: StoredSettings = {
  scale: 1,
  clickThrough: true,
  autoLaunch: false,
  locked: false,
  inertia: true,
  lowPower: false,
  pinnedSessions: [],
  taskPreferences: DEFAULT_TASK_PREFERENCES,
  notifications: DEFAULT_NOTIFICATIONS,
  dndUntil: 0,
  mergeNotifications: true,
  shortcuts: DEFAULT_SHORTCUTS,
  skinPath: null,
  windowPosition: null,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clampScale(value: number): number {
  return Math.min(1.6, Math.max(0.65, Math.round(value * 20) / 20))
}

export function parseSettingsUpdate(value: unknown): SettingsUpdate {
  if (!isRecord(value)) throw new TypeError("设置必须是一个对象")
  const update: SettingsUpdate = {}
  for (const key of ["clickThrough", "autoLaunch", "locked", "inertia", "lowPower", "mergeNotifications"] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== "boolean") throw new TypeError(`${key} 必须为开关值`)
    update[key] = value[key]
  }
  if (value.scale !== undefined) {
    if (typeof value.scale !== "number" || !Number.isFinite(value.scale)) throw new TypeError("缩放必须是有效数字")
    update.scale = clampScale(value.scale)
  }
  if (value.dndUntil !== undefined) {
    if (typeof value.dndUntil !== "number" || !Number.isFinite(value.dndUntil) || value.dndUntil < 0 || value.dndUntil > Date.now() + 7 * 86_400_000) {
      throw new TypeError("免打扰截止时间无效")
    }
    update.dndUntil = value.dndUntil > Date.now() ? value.dndUntil : 0
  }
  if (value.pinnedSessions !== undefined) {
    if (!Array.isArray(value.pinnedSessions) || value.pinnedSessions.length > 100
      || !value.pinnedSessions.every((key) => typeof key === "string" && key.length > 0 && key.length <= 2_000)) {
      throw new TypeError("最多置顶 100 个任务")
    }
    update.pinnedSessions = [...new Set(value.pinnedSessions as string[])]
  }
  if (value.taskPreferences !== undefined) {
    const filters = value.taskPreferences
    if (!isRecord(filters) || typeof filters.project !== "string" || filters.project.length > 2_000
      || !["all", "busy", "permission", "error"].includes(String(filters.status)) || typeof filters.collapseCompleted !== "boolean") {
      throw new TypeError("任务筛选设置无效")
    }
    update.taskPreferences = { project: filters.project, status: filters.status as "all" | "busy" | "permission" | "error", collapseCompleted: filters.collapseCompleted }
  }
  if (value.notifications !== undefined) {
    const rules = value.notifications
    if (!isRecord(rules)) throw new TypeError("通知设置无效")
    const parsed = structuredClone(DEFAULT_NOTIFICATIONS)
    for (const kind of ["task_done", "error", "permission", "question"] as const) {
      const rule = rules[kind]
      if (!isRecord(rule) || typeof rule.sound !== "boolean" || typeof rule.popup !== "boolean") throw new TypeError("每种通知都需要声音与弹窗开关")
      parsed[kind] = { sound: rule.sound, popup: rule.popup }
    }
    update.notifications = parsed
  }
  if (value.shortcuts !== undefined) {
    const shortcuts = value.shortcuts
    if (!isRecord(shortcuts) || typeof shortcuts.toggle !== "string" || typeof shortcuts.tasks !== "string"
      || shortcuts.toggle.length > 100 || shortcuts.tasks.length > 100) throw new TypeError("快捷键设置无效")
    const toggle = shortcuts.toggle.trim()
    const tasks = shortcuts.tasks.trim()
    if (toggle && tasks && toggle.toLowerCase() === tasks.toLowerCase()) throw new TypeError("两个操作不能使用相同快捷键")
    update.shortcuts = { toggle, tasks }
  }
  return update
}

function parseSettings(value: unknown): StoredSettings {
  const defaults = structuredClone(DEFAULT_SETTINGS)
  if (!isRecord(value)) return defaults

  const position = isRecord(value.windowPosition)
    && typeof value.windowPosition.x === "number"
    && Number.isFinite(value.windowPosition.x)
    && typeof value.windowPosition.y === "number"
    && Number.isFinite(value.windowPosition.y)
    ? { x: Math.round(value.windowPosition.x), y: Math.round(value.windowPosition.y) }
    : null

  // Migrate independently: one corrupt new preference must not discard an old skin or position.
  for (const key of Object.keys(defaults)) {
    if (key === "skinPath" || key === "windowPosition" || value[key] === undefined) continue
    try { Object.assign(defaults, parseSettingsUpdate({ [key]: value[key] })) } catch { /* Use the default for this field. */ }
  }
  return {
    ...defaults,
    skinPath: typeof value.skinPath === "string" && value.skinPath.length > 0
      ? value.skinPath
      : null,
    windowPosition: position,
  }
}

export class SettingsStore {
  private value: StoredSettings = structuredClone(DEFAULT_SETTINGS)
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string, private readonly saveOverride?: (settings: StoredSettings) => Promise<void>) {}

  async load(): Promise<void> {
    try {
      this.value = parseSettings(JSON.parse(await readFile(this.filePath, "utf8")) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read pet settings; using defaults", error)
      }
    }
  }

  get(): StoredSettings {
    return structuredClone(this.value)
  }

  async update(update: SettingsUpdate): Promise<StoredSettings> {
    const parsed = parseSettingsUpdate(update)
    return this.mutate((draft) => { Object.assign(draft, parsed) })
  }

  async setWindowPosition(position: WindowPosition): Promise<void> {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
    await this.mutate((draft) => { draft.windowPosition = { x: Math.round(position.x), y: Math.round(position.y) } })
  }

  async setSkinPath(skinPath: string | null): Promise<void> {
    await this.mutate((draft) => { draft.skinPath = skinPath })
  }

  private mutate(change: (draft: StoredSettings) => void): Promise<StoredSettings> {
    const request = this.writeQueue.catch(() => undefined).then(async () => {
      const draft = this.get()
      change(draft)
      await this.persist(draft)
      // Do not advertise preferences that failed to save, especially registered shortcuts.
      this.value = draft
      return this.get()
    })
    this.writeQueue = request.then(() => undefined, () => undefined)
    return request
  }

  private async persist(settings: StoredSettings): Promise<void> {
    if (this.saveOverride) return this.saveOverride(structuredClone(settings))
    const snapshot = JSON.stringify(settings, null, 2)
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 })
    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST" && code !== "EPERM") throw error
      await rm(this.filePath, { force: true })
      await rename(temporaryPath, this.filePath)
    }
  }
}
