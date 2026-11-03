import type {
  NotificationEvent,
  PermissionRepliedMessage,
  PermissionResponse,
  SessionState,
} from "@opencode-pet/protocol"

export const IPC_CHANNELS = {
  snapshot: "opencode-pet:snapshot",
  notify: "opencode-pet:notify",
  replyPermission: "opencode-pet:reply-permission",
  setClickThrough: "opencode-pet:set-click-through",
  setInteractiveRegions: "opencode-pet:set-interactive-regions",
  setWindowLayout: "opencode-pet:set-window-layout",
  getSettings: "opencode-pet:get-settings",
  getDiagnostics: "opencode-pet:get-diagnostics",
  updateSettings: "opencode-pet:update-settings",
  chooseSkin: "opencode-pet:choose-skin",
  windowAction: "opencode-pet:window-action",
  dragStart: "opencode-pet:drag-start",
  dragEnd: "opencode-pet:drag-end",
  dragState: "opencode-pet:drag-state",
} as const

export interface ConnectionView {
  id: string
  directory: string
  connected: boolean
}

export type AggregatedSession = SessionState & {
  instanceId: string
  instanceLabel: string
}

export interface AppSnapshot {
  connections: ConnectionView[]
  sessions: AggregatedSession[]
}

export type AppEvent =
  | {
      type: "notify"
      instanceId: string
      instanceLabel: string
      event: NotificationEvent
    }
  | { type: "alert"; kind: NotificationKind; title: string; message: string; count: number; sound: boolean }
  | { type: "settings.changed"; settings: PetSettings }
  | { type: "ui-action"; action: "open-tasks" | "open-settings" }
  | { type: "visibility"; visible: boolean }
  | ({
      type: "permission.replied"
      instanceId: string
      instanceLabel: string
    } & Omit<PermissionRepliedMessage, "type">)

export interface SkinPackage {
  name: string
  manifestPath: string
  manifest: Record<string, unknown>
  spritesheetDataUrl: string
}

export interface PetSettings {
  scale: number
  clickThrough: boolean
  autoLaunch: boolean
  locked: boolean
  inertia: boolean
  lowPower: boolean
  pinnedSessions: string[]
  taskPreferences: TaskPreferences
  notifications: NotificationPreferences
  dndUntil: number
  mergeNotifications: boolean
  shortcuts: ShortcutPreferences
  shortcutError?: string
  skinPath?: string
  skin: SkinPackage | null
}

export type NotificationKind = NotificationEvent["kind"]
export interface NotificationRule { sound: boolean; popup: boolean }
export type NotificationPreferences = Record<NotificationKind, NotificationRule>
export interface TaskPreferences {
  project: string
  status: "all" | "busy" | "permission" | "error"
  collapseCompleted: boolean
}
export interface ShortcutPreferences { toggle: string; tasks: string }
export interface AppDiagnostics {
  uptimeSeconds: number
  sessionCount: number
  connectionCount: number
  processes: Array<{ pid: number; type: string; cpuPercent: number; workingSetMB: number; privateMB: number }>
}

export const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  task_done: { sound: true, popup: true },
  error: { sound: true, popup: true },
  permission: { sound: true, popup: true },
  question: { sound: true, popup: true },
}
export const DEFAULT_TASK_PREFERENCES: TaskPreferences = { project: "", status: "all", collapseCompleted: true }
export const DEFAULT_SHORTCUTS: ShortcutPreferences = { toggle: "CommandOrControl+Alt+P", tasks: "CommandOrControl+Alt+T" }

export type SettingsUpdate = Partial<Omit<PetSettings, "skin" | "skinPath" | "shortcutError">>

export interface InteractiveRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface PetWindowLayout {
  panelOpen: boolean
  stageWidth: number
  stageHeight: number
}

/** Bound layout requests before resizing the native window. */
export function parseWindowLayout(value: unknown): PetWindowLayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Window layout must be an object")
  }
  const input = value as Record<string, unknown>
  if (typeof input.panelOpen !== "boolean"
    || typeof input.stageWidth !== "number" || !Number.isFinite(input.stageWidth)
    || typeof input.stageHeight !== "number" || !Number.isFinite(input.stageHeight)) {
    throw new TypeError("Window layout must contain a panel flag and finite stage dimensions")
  }
  if (input.stageWidth <= 0 || input.stageHeight <= 0 || input.stageWidth > 1_000 || input.stageHeight > 1_000) {
    throw new RangeError("Stage dimensions are outside the supported range")
  }
  return { panelOpen: input.panelOpen, stageWidth: input.stageWidth, stageHeight: input.stageHeight }
}

export type DragPhase = "picked" | "dragging" | "gliding" | "dropping" | "settled"

/** A renderer gesture is validated in main; native cursor coordinates remain authoritative. */
export interface DragGesture {
  screenX: number
  screenY: number
  timestamp: number
}

export interface DragState {
  phase: DragPhase
  vx: number
  vy: number
}

export function pointIsInInteractiveRegion(point: Point, regions: readonly InteractiveRegion[]): boolean {
  return regions.some((region) => (
    point.x >= region.x
    && point.y >= region.y
    && point.x < region.x + region.width
    && point.y < region.y + region.height
  ))
}

const MAX_INTERACTIVE_REGIONS = 128
const MAX_REGION_VALUE = 100_000
const MAX_DRAG_VALUE = 100_000

/** Validates untrusted renderer rectangles before the main process polls them. */
export function parseInteractiveRegions(value: unknown): InteractiveRegion[] {
  if (!Array.isArray(value) || value.length > MAX_INTERACTIVE_REGIONS) {
    throw new TypeError(`Interactive regions must be an array of at most ${MAX_INTERACTIVE_REGIONS} rectangles`)
  }

  return value.flatMap((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError(`Interactive region ${index} must be an object`)
    }
    const input = candidate as Record<string, unknown>
    const numbers = [input.x, input.y, input.width, input.height]
    if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new TypeError(`Interactive region ${index} must contain finite numbers`)
    }

    const [x, y, width, height] = numbers as [number, number, number, number]
    if (width < 0 || height < 0 || numbers.some((item) => Math.abs(item as number) > MAX_REGION_VALUE)) {
      throw new RangeError(`Interactive region ${index} is outside the supported range`)
    }
    if (width === 0 || height === 0) return []
    return [{ x, y, width, height }]
  })
}

/** Validates pointer coordinates supplied by the sandboxed renderer before an IPC drag action. */
export function parseDragGesture(value: unknown): DragGesture {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Drag gesture must be an object")
  }
  const input = value as Record<string, unknown>
  const values = [input.screenX, input.screenY, input.timestamp]
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new TypeError("Drag gesture must contain finite numbers")
  }
  const [screenX, screenY, timestamp] = values as [number, number, number]
  if (Math.abs(screenX) > MAX_DRAG_VALUE || Math.abs(screenY) > MAX_DRAG_VALUE || timestamp < 0 || timestamp > 1_000_000_000_000) {
    throw new RangeError("Drag gesture is outside the supported range")
  }
  return { screenX, screenY, timestamp }
}

export type WindowAction = "show" | "hide" | "toggle" | "minimize" | "close" | "quit"

export interface OpencodePetApi {
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
  onNotify(callback: (event: AppEvent) => void): () => void
  replyPermission(
    instanceId: string,
    sessionID: string,
    permissionID: string,
    response: PermissionResponse,
  ): Promise<void>
  setClickThrough(value: boolean): Promise<void>
  setInteractiveRegions?(regions: InteractiveRegion[]): Promise<void>
  setWindowLayout(layout: PetWindowLayout): Promise<void>
  getSettings(): Promise<PetSettings>
  getDiagnostics(): Promise<AppDiagnostics>
  updateSettings(update: SettingsUpdate): Promise<PetSettings>
  chooseSkin(): Promise<SkinPackage | null>
  windowAction(action: WindowAction): Promise<void>
  dragStart(gesture: DragGesture): Promise<void>
  dragEnd(gesture: DragGesture): Promise<void>
  onDragState(callback: (state: DragState) => void): () => void
}
