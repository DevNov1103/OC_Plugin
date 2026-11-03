import { describe, expect, test } from "bun:test"
import {
  isOneShotSkinMood,
  resolveSkinAnimation,
  skinAnimationDuration,
  skinFrameAt,
  skinFramePosition,
} from "../src/renderer/skin-animation"

const source = "data:image/png;base64,sample"
const skin = {
  spritesheetDataUrl: source,
  manifest: {
    frameWidth: 160,
    frameHeight: 160,
    animations: {
      idle: { row: 0, frames: 2, fps: 2 },
      reading: { row: 1, frames: 4, fps: 10 },
    },
  },
}

describe("skin animation", () => {
  test("resolves state aliases and falls back to the idle row", () => {
    expect(resolveSkinAnimation(skin, "thinking")?.row).toBe(1)
    expect(resolveSkinAnimation(skin, "permission")?.row).toBe(0)
  })

  test("crops individual frames and wraps a complete row", () => {
    const animation = resolveSkinAnimation(skin, "thinking")!
    expect(skinFrameAt(animation, 150)).toBe(1)
    expect(skinFrameAt(animation, 400)).toBe(0)
    expect(skinFrameAt(animation, Number.NaN)).toBe(0)
    expect(skinFramePosition(animation, 2)).toBe("-320px -160px")
  })

  test("rejects missing sheet dimensions and malformed row positions", () => {
    expect(resolveSkinAnimation({ spritesheetDataUrl: source }, "idle")).toBeNull()
    expect(resolveSkinAnimation({ ...skin, manifest: { ...skin.manifest, animations: { idle: { row: -1, frames: 2 } } } }, "idle")).toBeNull()
  })

  test("resolves drag aliases and lets one-shot actions hold their final frame", () => {
    const dragSkin = {
      spritesheetDataUrl: source,
      manifest: {
        frameWidth: 192,
        frameHeight: 208,
        animations: {
          idle: { row: 0, frames: 6, fps: 5.5 },
          celebrate: { row: 4, frames: 5, fps: 6 },
          retry: { row: 3, frames: 4, fps: 5.7 },
          "drag-left": { row: 2, frames: 8, fps: 7.5 },
          "drag-right": { row: 1, frames: 8, fps: 7.5 },
        },
      },
    }
    const pickup = resolveSkinAnimation(dragSkin, "pickup")!
    expect(pickup.row).toBe(4)
    expect(resolveSkinAnimation(dragSkin, "drag-left")?.row).toBe(2)
    expect(resolveSkinAnimation(dragSkin, "drag-right")?.row).toBe(1)
    expect(resolveSkinAnimation(dragSkin, "drop")?.row).toBe(0)
    expect(skinFrameAt(pickup, 2_000, false)).toBe(4)
    expect(skinAnimationDuration(pickup)).toBeCloseTo(833.333, 2)
    expect(isOneShotSkinMood("pickup")).toBe(true)
    expect(isOneShotSkinMood("drag-left")).toBe(false)
  })
})
