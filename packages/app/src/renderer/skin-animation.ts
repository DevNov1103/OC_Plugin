export type SkinMood =
  | "idle"
  | "thinking"
  | "working"
  | "permission"
  | "celebrate"
  | "error"
  | "retry"
  | "pickup"
  | "drag-left"
  | "drag-right"
  | "drop"

export interface ResolvedSkinAnimation {
  source: string
  frameWidth: number
  frameHeight: number
  row: number
  frames: number
  fps: number
}

type UnknownRecord = Record<string, unknown>

const STATE_ALIASES: Record<SkinMood, readonly string[]> = {
  idle: ["idle", "default", "rest", "standby"],
  thinking: ["thinking", "think", "reading", "searching"],
  working: ["working", "work", "busy", "typing", "running"],
  permission: ["permission", "ask", "waiting", "attention", "prompt"],
  celebrate: ["celebrate", "success", "done", "complete", "completed"],
  error: ["error", "failed", "failure", "sad"],
  retry: ["retry", "reconnect", "recovering", "recovery"],
  pickup: ["pickup", "picked", "jumping", "jump", "celebrate", "success"],
  "drag-left": ["drag-left", "drag_left", "running-left", "run-left", "left"],
  "drag-right": ["drag-right", "drag_right", "running-right", "run-right", "right"],
  drop: ["drop", "dropping", "land", "landing"],
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Resolve and validate a pet.json animation without trusting skin package contents. */
export function resolveSkinAnimation(skin: unknown, mood: SkinMood): ResolvedSkinAnimation | null {
  const skinPackage = record(skin)
  const manifest = Object.keys(record(skinPackage.manifest)).length
    ? record(skinPackage.manifest)
    : skinPackage
  const animations = record(manifest.animations)
  const sourceValue = skinPackage.spritesheetDataUrl ?? manifest.spritesheetDataUrl
  const source = typeof sourceValue === "string" ? sourceValue : ""
  const frameWidth = positiveNumber(manifest.frameWidth ?? skinPackage.frameWidth)
  const frameHeight = positiveNumber(manifest.frameHeight ?? skinPackage.frameHeight)
  if (!source || !frameWidth || !frameHeight) return null

  const animationName = STATE_ALIASES[mood].find((name) => Object.hasOwn(animations, name))
    ?? STATE_ALIASES.idle.find((name) => Object.hasOwn(animations, name))
  if (!animationName) return null

  const animation = record(animations[animationName])
  const row = nonNegativeInteger(animation.row)
  const frames = positiveNumber(animation.frames)
  const fps = positiveNumber(animation.fps)
  if (row === undefined || !frames) return null

  return {
    source,
    frameWidth,
    frameHeight,
    row,
    frames: Math.max(1, Math.floor(frames)),
    fps: Math.min(60, fps ?? 8),
  }
}

/** Pure time-to-frame mapping used by the renderer animation loop. */
export function skinFrameAt(animation: ResolvedSkinAnimation, elapsedMs: number, loop = true): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || animation.frames <= 1) return 0
  const frame = Math.floor(elapsedMs * animation.fps / 1_000)
  return loop ? frame % animation.frames : Math.min(animation.frames - 1, frame)
}

export function skinAnimationDuration(animation: ResolvedSkinAnimation): number {
  return animation.frames / animation.fps * 1_000
}

/** Motions with a defined end frame must not loop over a held drag visual. */
export function isOneShotSkinMood(mood: SkinMood): boolean {
  return mood === "pickup" || mood === "drop" || mood === "retry"
}

/** CSS pixel offset for one logical frame in a row-oriented spritesheet. */
export function skinFramePosition(animation: ResolvedSkinAnimation, frame: number): string {
  const normalized = Math.max(0, Math.min(animation.frames - 1, Math.floor(frame)))
  return `${-normalized * animation.frameWidth}px ${-animation.row * animation.frameHeight}px`
}
