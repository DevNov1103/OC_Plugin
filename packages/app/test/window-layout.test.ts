import { describe, expect, test } from "bun:test"
import { boundsForWindowLayout, PANEL_WINDOW_SIZE, positionForWindowSize, windowSizeForLayout, type WindowBounds } from "../src/main/window-layout"

const closed = { panelOpen: false, stageWidth: 245, stageHeight: 216 }
const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

describe("pet window layout", () => {
  test("shrinks the collapsed canvas and leaves room for scaled content and the toolbar", () => {
    expect(windowSizeForLayout(closed)).toEqual({ width: 280, height: 270 })
    expect(windowSizeForLayout({ panelOpen: false, stageWidth: 392, stageHeight: 346 }))
      .toEqual({ width: 416, height: 400 })
    expect(windowSizeForLayout({ ...closed, panelOpen: true })).toEqual(PANEL_WINDOW_SIZE)
  })

  test("opening and closing the panel keeps the bottom-centre pet anchor in place", () => {
    const expanded = { x: 700, y: 300, ...PANEL_WINDOW_SIZE }
    const compact = boundsForWindowLayout(expanded, closed, [workArea])
    expect(compact).toEqual({ x: 750, y: 550, width: 280, height: 270 })
    expect(boundsForWindowLayout(compact, { ...closed, panelOpen: true }, [workArea])).toEqual(expanded)
    // The saved coordinates must be independent of the current panel mode.
    expect(positionForWindowSize(compact, PANEL_WINDOW_SIZE)).toEqual({ x: expanded.x, y: expanded.y })
  })

  test("expanding near a monitor edge stays on that display and inside its work area", () => {
    const second = { x: 1920, y: -100, width: 1280, height: 800 }
    const result = boundsForWindowLayout(
      { x: 2920, y: -80, width: 280, height: 270 },
      { ...closed, panelOpen: true },
      [workArea, second],
    )
    expect(result).toEqual({ x: 2820, y: -100, ...PANEL_WINDOW_SIZE })
  })

  test("odd compact widths do not accumulate a pixel of drift on each panel toggle", () => {
    const oddLayout = { panelOpen: false, stageWidth: 269, stageHeight: 348 }
    const expanded = { x: 700, y: 300, ...PANEL_WINDOW_SIZE }
    let bounds: WindowBounds = expanded
    for (let index = 0; index < 10; index++) {
      const compact = boundsForWindowLayout(bounds, oddLayout, [workArea])
      expect(compact.width).toBe(293)
      expect(positionForWindowSize(compact, PANEL_WINDOW_SIZE)).toEqual({ x: 700, y: 300 })
      bounds = boundsForWindowLayout(compact, { ...oddLayout, panelOpen: true }, [workArea])
    }
    expect(bounds).toEqual(expanded)
  })
})
