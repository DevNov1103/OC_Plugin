import type { DragGesture } from "../shared/ipc"

export const CLICK_DISTANCE_PX = 5
export const CLICK_DURATION_MS = 320
export const DRAG_DEAD_ZONE = 40
export const DRAG_SWITCH_THRESHOLD = 56

export type DragDirection = "left" | "right" | null

export interface PointerSnapshot {
  clientX: number
  clientY: number
  screenX: number
  screenY: number
  timestamp: number
}

interface ActivePointer extends PointerSnapshot {
  pointerId: number
  target: HTMLElement
  dragging: boolean
}

export interface DragHandlerOptions {
  isLocked?(): boolean
  onDragStart(gesture: DragGesture): Promise<void> | void
  onDragEnd(gesture: DragGesture): Promise<void> | void
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

export function pointerDistance(start: Pick<PointerSnapshot, "clientX" | "clientY">, end: Pick<PointerSnapshot, "clientX" | "clientY">): number {
  return Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY)
}

export function isClickGesture(start: PointerSnapshot, end: PointerSnapshot): boolean {
  return pointerDistance(start, end) < CLICK_DISTANCE_PX
    && Math.max(0, end.timestamp - start.timestamp) < CLICK_DURATION_MS
}

/** Keeps a running direction through small reversals, but returns idle inside the 40 px/s dead zone. */
export function dragDirectionForVelocity(vx: number, previous: DragDirection): DragDirection {
  if (!Number.isFinite(vx) || Math.abs(vx) < DRAG_DEAD_ZONE) return null
  if (previous === "right" && vx > -DRAG_SWITCH_THRESHOLD) return "right"
  if (previous === "left" && vx < DRAG_SWITCH_THRESHOLD) return "left"
  return vx > 0 ? "right" : "left"
}

export function dragTiltForVelocity(vx: number): number {
  return Math.max(-8, Math.min(8, finite(vx) * 0.02))
}

function asGesture(pointer: PointerSnapshot): DragGesture {
  return {
    screenX: finite(pointer.screenX),
    screenY: finite(pointer.screenY),
    timestamp: Math.max(0, finite(pointer.timestamp)),
  }
}

function snapshot(event: PointerEvent): PointerSnapshot {
  return {
    clientX: finite(event.clientX),
    clientY: finite(event.clientY),
    screenX: finite(event.screenX),
    screenY: finite(event.screenY),
    timestamp: Math.max(0, finite(event.timeStamp)),
  }
}

function draggableTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  if (target.closest(".panel")) return null
  return target.closest<HTMLElement>(".pet-button, .bubble, .status-pill")
}

/**
 * Installs a capture-based gesture layer without replacing the persistent pet DOM.
 * Short taps are deliberately left as normal click events so the panel still opens.
 */
export function mountDragHandlers(root: HTMLElement, options: DragHandlerOptions): () => void {
  const documentBody = root.ownerDocument.body
  let active: ActivePointer | null = null
  let startRequest: Promise<unknown> = Promise.resolve()
  let suppressClickUntil = 0

  const request = (callback: (gesture: DragGesture) => Promise<void> | void, pointer: PointerSnapshot): Promise<unknown> => (
    Promise.resolve(callback(asGesture(pointer))).catch(() => undefined)
  )

  const releaseCapture = (pointer: ActivePointer): void => {
    try {
      if (pointer.target.hasPointerCapture(pointer.pointerId)) pointer.target.releasePointerCapture(pointer.pointerId)
    } catch { /* Pointer capture can already be gone after a cancel. */ }
  }

  const begin = (pointer: ActivePointer, current: PointerSnapshot): void => {
    if (pointer.dragging) return
    pointer.dragging = true
    documentBody.classList.add("dragging")
    startRequest = request(options.onDragStart, current)
  }

  const finish = (event: PointerEvent, cancelled = false): void => {
    const pointer = active
    if (!pointer || pointer.pointerId !== event.pointerId) return
    const current = snapshot(event)
    if (!pointer.dragging && !cancelled && !isClickGesture(pointer, current)) begin(pointer, current)
    const wasDragging = pointer.dragging
    active = null
    releaseCapture(pointer)
    documentBody.classList.remove("dragging")
    if (!wasDragging) return
    suppressClickUntil = performance.now() + 450
    void startRequest.finally(() => request(options.onDragEnd, current))
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (active || options.isLocked?.() || event.button !== 0 || event.isPrimary === false) return
    const target = draggableTarget(event.target)
    if (!target) return
    const current = snapshot(event)
    active = { ...current, pointerId: event.pointerId, target, dragging: false }
    try { target.setPointerCapture(event.pointerId) } catch { /* Browser support is optional during tests. */ }
  }

  const onPointerMove = (event: PointerEvent): void => {
    const pointer = active
    if (!pointer || pointer.pointerId !== event.pointerId) return
    const current = snapshot(event)
    if (!pointer.dragging && !isClickGesture(pointer, current)) begin(pointer, current)
    if (pointer.dragging) event.preventDefault()
  }

  const onPointerUp = (event: PointerEvent): void => finish(event)
  const onPointerCancel = (event: PointerEvent): void => finish(event, true)
  const onClickCapture = (event: MouseEvent): void => {
    if (performance.now() > suppressClickUntil) return
    const target = draggableTarget(event.target)
    if (!target) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  root.addEventListener("pointerdown", onPointerDown)
  root.addEventListener("pointermove", onPointerMove)
  root.addEventListener("pointerup", onPointerUp)
  root.addEventListener("pointercancel", onPointerCancel)
  root.addEventListener("lostpointercapture", onPointerCancel, true)
  root.addEventListener("click", onClickCapture, true)

  return (): void => {
    if (active) releaseCapture(active)
    active = null
    documentBody.classList.remove("dragging")
    root.removeEventListener("pointerdown", onPointerDown)
    root.removeEventListener("pointermove", onPointerMove)
    root.removeEventListener("pointerup", onPointerUp)
    root.removeEventListener("pointercancel", onPointerCancel)
    root.removeEventListener("lostpointercapture", onPointerCancel, true)
    root.removeEventListener("click", onClickCapture, true)
  }
}
