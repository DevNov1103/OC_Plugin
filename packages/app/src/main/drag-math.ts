export interface DragPoint {
  x: number
  y: number
}

export interface DragVelocity {
  x: number
  y: number
}

export interface DragSample extends DragPoint {
  timestamp: number
}

export interface DragSize {
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface PositionBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface InertiaStep {
  position: DragPoint
  velocity: DragVelocity
  workArea: WorkArea
  bouncedHorizontally: boolean
}

export const DRAG_STOP_SPEED = 60
export const DRAG_FRICTION = 3.2
export const MAX_GLIDE_DURATION_MS = 5_000

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function distanceToWorkAreaSquared(point: DragPoint, workArea: WorkArea): number {
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  const dx = point.x < workArea.x ? workArea.x - point.x : point.x > right ? point.x - right : 0
  const dy = point.y < workArea.y ? workArea.y - point.y : point.y > bottom ? point.y - bottom : 0
  return dx * dx + dy * dy
}

function safeWorkAreas(workAreas: readonly WorkArea[]): readonly WorkArea[] {
  const valid = workAreas.filter((area) => (
    Number.isFinite(area.x)
    && Number.isFinite(area.y)
    && Number.isFinite(area.width)
    && Number.isFinite(area.height)
    && area.width > 0
    && area.height > 0
  ))
  return valid.length ? valid : [{ x: 0, y: 0, width: 1, height: 1 }]
}

/** Finds the containing display first, then the nearest visible work area. */
export function closestWorkArea(point: DragPoint, workAreas: readonly WorkArea[]): WorkArea {
  const areas = safeWorkAreas(workAreas)
  let closest = areas[0]!
  let closestDistance = distanceToWorkAreaSquared(point, closest)
  for (const area of areas.slice(1)) {
    const distance = distanceToWorkAreaSquared(point, area)
    if (distance < closestDistance) {
      closest = area
      closestDistance = distance
    }
  }
  return closest
}

/** Bounds that keep the whole frameless window visible inside one work area. */
export function boundsForWorkArea(workArea: WorkArea, size: DragSize, margin = 0): PositionBounds {
  const horizontalSpace = workArea.width - size.width
  const verticalSpace = workArea.height - size.height
  const safeHorizontalMargin = Math.min(Math.max(0, margin), Math.max(0, horizontalSpace) / 2)
  const safeVerticalMargin = Math.min(Math.max(0, margin), Math.max(0, verticalSpace) / 2)
  const minX = horizontalSpace >= 0
    ? workArea.x + safeHorizontalMargin
    : workArea.x + horizontalSpace / 2
  const maxX = horizontalSpace >= 0
    ? workArea.x + horizontalSpace - safeHorizontalMargin
    : minX
  const minY = verticalSpace >= 0
    ? workArea.y + safeVerticalMargin
    : workArea.y + verticalSpace / 2
  const maxY = verticalSpace >= 0
    ? workArea.y + verticalSpace - safeVerticalMargin
    : minY
  return { minX, maxX, minY, maxY }
}

export function clampWindowPosition(
  position: DragPoint,
  size: DragSize,
  workAreas: readonly WorkArea[],
  referencePoint?: DragPoint,
  margin = 0,
): { position: DragPoint; workArea: WorkArea } {
  const reference = referencePoint ?? {
    x: position.x + size.width / 2,
    y: position.y + size.height / 2,
  }
  const workArea = closestWorkArea(reference, workAreas)
  const bounds = boundsForWorkArea(workArea, size, margin)
  return {
    position: {
      x: clamp(position.x, bounds.minX, bounds.maxX),
      y: clamp(position.y, bounds.minY, bounds.maxY),
    },
    workArea,
  }
}

/** Uses only the most recent 100 ms of pointer samples, avoiding stale throw speeds. */
export function velocityFromSamples(samples: readonly DragSample[], windowMs = 100): DragVelocity {
  const valid = samples.filter((sample) => (
    Number.isFinite(sample.x)
    && Number.isFinite(sample.y)
    && Number.isFinite(sample.timestamp)
  ))
  if (valid.length < 2) return { x: 0, y: 0 }
  const newest = valid[valid.length - 1]!
  const withinWindow = valid.filter((sample) => {
    const age = newest.timestamp - sample.timestamp
    return age >= 1 && age <= windowMs
  })
  const oldest = withinWindow[0] ?? valid.find((sample) => newest.timestamp - sample.timestamp >= 1)
  if (!oldest) return { x: 0, y: 0 }
  const elapsedSeconds = (newest.timestamp - oldest.timestamp) / 1_000
  if (elapsedSeconds <= 0) return { x: 0, y: 0 }
  return {
    x: (newest.x - oldest.x) / elapsedSeconds,
    y: (newest.y - oldest.y) / elapsedSeconds,
  }
}

/** Advances one inertia tick, bouncing only against horizontal display edges. */
export function advanceInertia(
  position: DragPoint,
  velocity: DragVelocity,
  elapsedSeconds: number,
  size: DragSize,
  workAreas: readonly WorkArea[],
  friction = DRAG_FRICTION,
  restitution = 0.35,
): InertiaStep {
  const dt = clamp(Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0, 0, 0.1)
  const decay = Math.exp(-Math.max(0, friction) * dt)
  let nextVelocity = {
    x: Number.isFinite(velocity.x) ? velocity.x * decay : 0,
    y: Number.isFinite(velocity.y) ? velocity.y * decay : 0,
  }
  const desired = {
    x: position.x + nextVelocity.x * dt,
    y: position.y + nextVelocity.y * dt,
  }
  const reference = { x: desired.x + size.width / 2, y: desired.y + size.height / 2 }
  const workArea = closestWorkArea(reference, workAreas)
  const bounds = boundsForWorkArea(workArea, size)
  let bouncedHorizontally = false

  if (desired.x < bounds.minX) {
    desired.x = bounds.minX
    nextVelocity.x = Math.abs(nextVelocity.x) * restitution
    bouncedHorizontally = true
  } else if (desired.x > bounds.maxX) {
    desired.x = bounds.maxX
    nextVelocity.x = -Math.abs(nextVelocity.x) * restitution
    bouncedHorizontally = true
  }
  // Vertical edges stop the window without an artificial bounce.
  desired.y = clamp(desired.y, bounds.minY, bounds.maxY)

  return { position: desired, velocity: nextVelocity, workArea, bouncedHorizontally }
}

export function shouldStopGliding(velocity: DragVelocity, elapsedMs: number): boolean {
  const speed = Math.hypot(
    Number.isFinite(velocity.x) ? velocity.x : 0,
    Number.isFinite(velocity.y) ? velocity.y : 0,
  )
  return speed < DRAG_STOP_SPEED || elapsedMs >= MAX_GLIDE_DURATION_MS
}
