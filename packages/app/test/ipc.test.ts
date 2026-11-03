import { describe, expect, test } from "bun:test"
import { parseDragGesture, parseInteractiveRegions, parseWindowLayout, pointIsInInteractiveRegion } from "../src/shared/ipc"

describe("interactive region IPC validation", () => {
  test("accepts finite rectangles and drops empty ones", () => {
    expect(parseInteractiveRegions([
      { x: 10, y: -2.5, width: 40, height: 20 },
      { x: 0, y: 0, width: 0, height: 10 },
    ])).toEqual([{ x: 10, y: -2.5, width: 40, height: 20 }])
  })

  test("rejects malformed, negative-size, or excessive input", () => {
    expect(() => parseInteractiveRegions([{ x: 0, y: 0, width: -1, height: 1 }])).toThrow(RangeError)
    expect(() => parseInteractiveRegions([{ x: 0, y: 0, width: Number.NaN, height: 1 }])).toThrow(TypeError)
    expect(() => parseInteractiveRegions(Array.from({ length: 129 }, () => ({ x: 0, y: 0, width: 1, height: 1 })))).toThrow(TypeError)
  })

  test("uses half-open rectangle edges for stable adjacent hit regions", () => {
    const regions = [{ x: 10, y: 20, width: 30, height: 40 }]
    expect(pointIsInInteractiveRegion({ x: 10, y: 20 }, regions)).toBe(true)
    expect(pointIsInInteractiveRegion({ x: 39.999, y: 59.999 }, regions)).toBe(true)
    expect(pointIsInInteractiveRegion({ x: 40, y: 30 }, regions)).toBe(false)
    expect(pointIsInInteractiveRegion({ x: 20, y: 60 }, regions)).toBe(false)
  })
})

describe("drag gesture IPC validation", () => {
  test("accepts finite renderer proof but rejects invalid or excessive values", () => {
    expect(parseDragGesture({ screenX: 320, screenY: -40, timestamp: 123.5 }))
      .toEqual({ screenX: 320, screenY: -40, timestamp: 123.5 })
    expect(() => parseDragGesture({ screenX: Number.NaN, screenY: 0, timestamp: 1 })).toThrow(TypeError)
    expect(() => parseDragGesture({ screenX: 100_001, screenY: 0, timestamp: 1 })).toThrow(RangeError)
    expect(() => parseDragGesture({ screenX: 0, screenY: 0, timestamp: -1 })).toThrow(RangeError)
  })
})

describe("window layout IPC validation", () => {
  test("accepts measured content and rejects invalid flags or unbounded dimensions", () => {
    const layout = { panelOpen: false, stageWidth: 245, stageHeight: 216 }
    expect(parseWindowLayout(layout)).toEqual(layout)
    expect(() => parseWindowLayout({ ...layout, panelOpen: "false" })).toThrow(TypeError)
    expect(() => parseWindowLayout({ ...layout, stageWidth: Infinity })).toThrow(TypeError)
    expect(() => parseWindowLayout({ ...layout, stageHeight: 0 })).toThrow(RangeError)
    expect(() => parseWindowLayout({ ...layout, stageWidth: 1_001 })).toThrow(RangeError)
  })
})
