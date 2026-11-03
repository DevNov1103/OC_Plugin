import { describe, expect, test } from "bun:test"
import {
  dragDirectionForVelocity,
  dragTiltForVelocity,
  isClickGesture,
} from "../src/renderer/drag"

const pointer = (clientX: number, timestamp: number) => ({
  clientX,
  clientY: 10,
  screenX: clientX,
  screenY: 10,
  timestamp,
})

describe("renderer drag gesture", () => {
  test("preserves short, tiny movement as a panel click", () => {
    expect(isClickGesture(pointer(10, 0), pointer(14.9, 319))).toBe(true)
    expect(isClickGesture(pointer(10, 0), pointer(15, 100))).toBe(false)
    expect(isClickGesture(pointer(10, 0), pointer(10, 320))).toBe(false)
  })

  test("uses a 40 px/s dead zone and hysteresis before switching direction", () => {
    expect(dragDirectionForVelocity(39, null)).toBeNull()
    expect(dragDirectionForVelocity(41, null)).toBe("right")
    expect(dragDirectionForVelocity(-45, "right")).toBe("right")
    expect(dragDirectionForVelocity(-57, "right")).toBe("left")
    expect(dragDirectionForVelocity(45, "left")).toBe("left")
    expect(dragDirectionForVelocity(57, "left")).toBe("right")
  })

  test("caps visual tilt at eight degrees", () => {
    expect(dragTiltForVelocity(100)).toBe(2)
    expect(dragTiltForVelocity(9_999)).toBe(8)
    expect(dragTiltForVelocity(-9_999)).toBe(-8)
  })
})
