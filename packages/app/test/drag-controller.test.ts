import { describe, expect, test } from "bun:test"
import type { BrowserWindow } from "electron"
import { DragController } from "../src/main/drag"
import type { DragState } from "../src/shared/ipc"

const gesture = { screenX: 850, screenY: 200, timestamp: 0 }

function createFixture(inertiaEnabled = true) {
  let now = 0
  let cursor = { x: 850, y: 200 }
  const bounds = { x: 650, y: 100, width: 380, height: 520 }
  const moves: Array<{ x: number; y: number }> = []
  const persisted: Array<{ x: number; y: number }> = []
  const restoredPreferences: boolean[] = []
  const clickThrough: boolean[] = []
  const states: DragState[] = []
  const listeners = new Set<(state: DragState) => void>()
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setPosition: (x: number, y: number) => {
      bounds.x = x
      bounds.y = y
      moves.push({ x, y })
    },
  } as unknown as BrowserWindow
  const controller = new DragController({
    getWindow: () => window,
    getCursor: () => cursor,
    getWorkAreas: () => [{ x: 0, y: 0, width: 1_920, height: 1_080 }],
    stopHitTestPolling: () => {},
    applyClickThrough: (value) => clickThrough.push(value),
    syncHitTesting: (value) => restoredPreferences.push(value),
    clickThroughEnabled: () => true,
    inertiaEnabled: () => inertiaEnabled,
    persistWindowPosition: () => persisted.push({ x: bounds.x, y: bounds.y }),
    sendState: (state) => {
      states.push(state)
      for (const listener of listeners) listener(state)
    },
    now: () => now,
  })

  function waitForPhase(phase: DragState["phase"]): Promise<DragState> {
    const existing = states.find((state) => state.phase === phase)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener)
        reject(new Error(`Timed out waiting for ${phase}`))
      }, 2_000)
      const listener = (state: DragState) => {
        if (state.phase !== phase) return
        clearTimeout(timer)
        listeners.delete(listener)
        resolve(state)
      }
      listeners.add(listener)
    })
  }

  return {
    bounds, moves, persisted, restoredPreferences, clickThrough, states, controller, waitForPhase,
    moveCursor: (x: number, y: number, timestamp: number) => { cursor = { x, y }; now = timestamp },
    setTime: (timestamp: number) => { now = timestamp },
  }
}

describe("drag landing without edge attraction", () => {
  test("lands directly after a fast release when inertia is disabled", async () => {
    const fixture = createFixture(false)
    try {
      fixture.controller.start(gesture)
      fixture.moveCursor(950, 200, 50)
      await fixture.waitForPhase("dragging")
      fixture.controller.end(gesture)
      expect(fixture.states.at(-1)?.phase).toBe("dropping")
      const moves = fixture.moves.length
      await fixture.waitForPhase("settled")
      expect(fixture.moves).toHaveLength(moves)
      expect(fixture.states.some((state) => state.phase === "gliding")).toBe(false)
    } finally { fixture.controller.cancel() }
  })
  test("keeps a low-speed release where it was dropped and restores hit testing", async () => {
    const fixture = createFixture()
    try {
      fixture.controller.start(gesture)
      fixture.controller.end(gesture)
      expect(fixture.states.at(-1)?.phase).toBe("dropping")
      expect(fixture.controller.isActive()).toBe(true)
      await fixture.waitForPhase("settled")

      expect(fixture.moves).toEqual([])
      expect(fixture.persisted).toEqual([{ x: 650, y: 100 }])
      expect(fixture.controller.isActive()).toBe(false)
      expect(fixture.clickThrough).toEqual([false])
      expect(fixture.restoredPreferences).toEqual([true])
    } finally {
      fixture.controller.cancel()
    }
  })

  test("keeps the final inertia position throughout landing instead of moving to either edge", async () => {
    const fixture = createFixture()
    try {
      fixture.controller.start(gesture)
      fixture.moveCursor(950, 200, 50)
      await fixture.waitForPhase("dragging")
      fixture.controller.end(gesture)
      expect(fixture.states.at(-1)?.phase).toBe("gliding")

      fixture.setTime(5_050)
      await fixture.waitForPhase("dropping")
      const releasePosition = { x: fixture.bounds.x, y: fixture.bounds.y }
      const movesAtLanding = fixture.moves.length
      expect(releasePosition.x).toBeGreaterThan(750)
      expect(releasePosition.x).toBeLessThan(1_540)
      await fixture.waitForPhase("settled")

      expect(fixture.moves).toHaveLength(movesAtLanding)
      expect(fixture.persisted).toEqual([releasePosition])
      expect(fixture.restoredPreferences).toEqual([true])
      expect(fixture.controller.isActive()).toBe(false)
    } finally {
      fixture.controller.cancel()
    }
  })
})
