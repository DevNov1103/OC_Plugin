import type { BrowserWindow } from "electron"
import type { DragGesture, DragState } from "../shared/ipc"
import {
  advanceInertia,
  clampWindowPosition,
  DRAG_STOP_SPEED,
  MAX_GLIDE_DURATION_MS,
  shouldStopGliding,
  velocityFromSamples,
  type DragPoint,
  type DragSample,
  type DragSize,
  type DragVelocity,
  type WorkArea,
} from "./drag-math"

const FOLLOW_INTERVAL_MS = 8
const INERTIA_INTERVAL_MS = 8
const DROP_DURATION_MS = 320
const MAX_STATE_RATE_MS = 1_000 / 30
const MAX_SPEED = 100_000

export interface DragControllerOptions {
  getWindow(): BrowserWindow | null
  getCursor(): DragPoint
  getWorkAreas(): WorkArea[]
  stopHitTestPolling(): void
  applyClickThrough(value: boolean): void
  syncHitTesting(preferenceEnabled: boolean): void
  clickThroughEnabled(): boolean
  inertiaEnabled?(): boolean
  persistWindowPosition(): void
  sendState(state: DragState): void
  now?(): number
}

function timerUnref(timer: NodeJS.Timeout): void {
  timer.unref?.()
}

function rounded(point: DragPoint): DragPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

function safeVelocity(velocity: DragVelocity): DragVelocity {
  const normalize = (value: number): number => (
    Number.isFinite(value) ? Math.max(-MAX_SPEED, Math.min(MAX_SPEED, value)) : 0
  )
  return { x: normalize(velocity.x), y: normalize(velocity.y) }
}

function speed(velocity: DragVelocity): number {
  return Math.hypot(velocity.x, velocity.y)
}

/**
 * Moves the frameless window using native screen coordinates. Renderer coordinates
 * are deliberately not trusted as the source of motion; they are only gesture proof.
 */
export class DragController {
  private active = false
  private phase: DragState["phase"] = "settled"
  private initialCursor: DragPoint = { x: 0, y: 0 }
  private initialPosition: DragPoint = { x: 0, y: 0 }
  private samples: DragSample[] = []
  private velocity: DragVelocity = { x: 0, y: 0 }
  private lastStepAt = 0
  private glideStartedAt = 0
  private lastStateAt = -Infinity
  private followTimer: NodeJS.Timeout | undefined
  private inertiaTimer: NodeJS.Timeout | undefined
  private settleTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: DragControllerOptions) {}

  isActive(): boolean {
    return this.active
  }

  start(gesture: DragGesture): void {
    // `gesture` was validated at the IPC boundary. Native Electron coordinates below
    // remain authoritative, so renderer input can never move the window by itself.
    void gesture
    if (this.active) return
    const window = this.window()
    if (!window) return

    this.clearTimers()
    const bounds = window.getBounds()
    const cursor = this.cursor()
    this.active = true
    this.phase = "picked"
    this.initialCursor = cursor
    this.initialPosition = { x: bounds.x, y: bounds.y }
    this.samples = []
    this.velocity = { x: 0, y: 0 }
    this.lastStepAt = this.now()
    this.recordSample(cursor)

    this.options.stopHitTestPolling()
    this.options.applyClickThrough(false)
    this.emit("picked", this.velocity, true)
    this.followTimer = setInterval(() => this.followCursor(), FOLLOW_INTERVAL_MS)
    timerUnref(this.followTimer)
  }

  end(gesture: DragGesture): void {
    void gesture
    if (!this.active) return
    if (this.followTimer) clearInterval(this.followTimer)
    this.followTimer = undefined
    this.recordSample(this.cursor())
    this.velocity = safeVelocity(velocityFromSamples(this.samples))
    if (this.options.inertiaEnabled?.() === false || speed(this.velocity) < DRAG_STOP_SPEED) {
      this.beginDropping()
      return
    }

    this.phase = "gliding"
    this.glideStartedAt = this.now()
    this.lastStepAt = this.glideStartedAt
    this.emit("gliding", this.velocity, true)
    this.inertiaTimer = setInterval(() => this.glide(), INERTIA_INTERVAL_MS)
    timerUnref(this.inertiaTimer)
  }

  /** Used by window hide, destruction, and app shutdown paths. */
  cancel(): void {
    if (!this.active) return
    this.clearTimers()
    this.finish()
  }

  private followCursor(): void {
    if (!this.active) return
    const window = this.window()
    if (!window) {
      this.cancel()
      return
    }
    const cursor = this.cursor()
    this.recordSample(cursor)
    const bounds = window.getBounds()
    const size: DragSize = { width: bounds.width, height: bounds.height }
    const desired = {
      x: this.initialPosition.x + cursor.x - this.initialCursor.x,
      y: this.initialPosition.y + cursor.y - this.initialCursor.y,
    }
    const clamped = clampWindowPosition(desired, size, this.workAreas(), cursor)
    const point = rounded(clamped.position)
    window.setPosition(point.x, point.y)
    this.velocity = safeVelocity(velocityFromSamples(this.samples))
    if (this.phase === "picked" && (Math.abs(cursor.x - this.initialCursor.x) > 1 || Math.abs(cursor.y - this.initialCursor.y) > 1)) {
      this.phase = "dragging"
    }
    this.emit(this.phase, this.velocity)
  }

  private glide(): void {
    if (!this.active) return
    const window = this.window()
    if (!window) {
      this.cancel()
      return
    }
    const now = this.now()
    const elapsedSeconds = Math.max(0, now - this.lastStepAt) / 1_000
    this.lastStepAt = now
    const bounds = window.getBounds()
    const step = advanceInertia(
      { x: bounds.x, y: bounds.y },
      this.velocity,
      elapsedSeconds,
      { width: bounds.width, height: bounds.height },
      this.workAreas(),
    )
    this.velocity = safeVelocity(step.velocity)
    const point = rounded(step.position)
    window.setPosition(point.x, point.y)
    this.emit("gliding", this.velocity)
    if (shouldStopGliding(this.velocity, now - this.glideStartedAt) || now - this.glideStartedAt >= MAX_GLIDE_DURATION_MS) {
      this.beginDropping()
    }
  }

  private beginDropping(): void {
    if (!this.active) return
    if (this.inertiaTimer) clearInterval(this.inertiaTimer)
    this.inertiaTimer = undefined
    const window = this.window()
    if (!window) {
      this.cancel()
      return
    }
    this.phase = "dropping"
    this.emit("dropping", this.velocity, true)
    // Landing is visual only: keep the release or final glide position unchanged.
    this.settleTimer = setTimeout(() => this.finish(), DROP_DURATION_MS)
    timerUnref(this.settleTimer)
  }

  private finish(): void {
    this.clearTimers()
    const wasActive = this.active
    this.active = false
    this.phase = "settled"
    this.velocity = { x: 0, y: 0 }
    if (wasActive) this.options.persistWindowPosition()
    this.options.syncHitTesting(this.options.clickThroughEnabled())
    this.emit("settled", this.velocity, true)
  }

  private window(): BrowserWindow | null {
    const window = this.options.getWindow()
    return window && !window.isDestroyed() ? window : null
  }

  private cursor(): DragPoint {
    const point = this.options.getCursor()
    return {
      x: Number.isFinite(point.x) ? point.x : 0,
      y: Number.isFinite(point.y) ? point.y : 0,
    }
  }

  private workAreas(): WorkArea[] {
    return this.options.getWorkAreas()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private recordSample(point: DragPoint): void {
    const timestamp = this.now()
    this.samples.push({ ...point, timestamp })
    this.samples = this.samples.filter((sample) => timestamp - sample.timestamp <= 100)
  }

  private emit(phase: DragState["phase"], velocity: DragVelocity, force = false): void {
    const now = this.now()
    if (!force && now - this.lastStateAt < MAX_STATE_RATE_MS) return
    this.lastStateAt = now
    const safe = safeVelocity(velocity)
    this.options.sendState({ phase, vx: safe.x, vy: safe.y })
  }

  private clearTimers(): void {
    if (this.followTimer) clearInterval(this.followTimer)
    if (this.inertiaTimer) clearInterval(this.inertiaTimer)
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.followTimer = undefined
    this.inertiaTimer = undefined
    this.settleTimer = undefined
  }
}
