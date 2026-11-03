import { describe, expect, test } from "bun:test"
import {
  advanceInertia,
  clampWindowPosition,
  shouldStopGliding,
  velocityFromSamples,
} from "../src/main/drag-math"

const primary = { x: 0, y: 0, width: 1_000, height: 800 }
const petSize = { width: 380, height: 520 }

describe("drag math", () => {
  test("uses the last 100 ms of samples for throw velocity", () => {
    expect(velocityFromSamples([
      { x: 0, y: 0, timestamp: 0 },
      { x: 15, y: 5, timestamp: 50 },
      { x: 30, y: 10, timestamp: 100 },
    ])).toEqual({ x: 300, y: 100 })
  })

  test("clamps a manual drag to the closest real display rather than an imaginary combined rectangle", () => {
    const clamped = clampWindowPosition(
      { x: 760, y: 12 },
      { width: 200, height: 200 },
      [
        { x: 0, y: 0, width: 500, height: 500 },
        { x: 1_000, y: 0, width: 500, height: 500 },
      ],
      { x: 1_020, y: 100 },
    )
    expect(clamped.workArea.x).toBe(1_000)
    expect(clamped.position).toEqual({ x: 1_000, y: 12 })
  })

  test("decays inertia, bounces at horizontal edges, and only clamps vertical edges", () => {
    const horizontal = advanceInertia(
      { x: 615, y: 100 },
      { x: 1_000, y: 0 },
      .1,
      petSize,
      [primary],
    )
    expect(horizontal.position.x).toBe(620)
    expect(horizontal.velocity.x).toBeLessThan(0)
    expect(horizontal.bouncedHorizontally).toBe(true)

    const vertical = advanceInertia(
      { x: 100, y: 275 },
      { x: 0, y: 1_000 },
      .1,
      petSize,
      [primary],
    )
    expect(vertical.position.y).toBe(280)
    expect(vertical.velocity.y).toBeGreaterThan(0)
    expect(vertical.bouncedHorizontally).toBe(false)
  })

  test("stops after low velocity or five seconds", () => {
    expect(shouldStopGliding({ x: 59, y: 0 }, 20)).toBe(true)
    expect(shouldStopGliding({ x: 500, y: 0 }, 5_000)).toBe(true)
    expect(shouldStopGliding({ x: 500, y: 0 }, 4_999)).toBe(false)
  })
})
