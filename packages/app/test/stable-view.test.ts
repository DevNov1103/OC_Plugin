import { describe, expect, test } from "bun:test"
import { mountPetView, type PetView } from "../src/renderer/stable-view"

class ViewElement {
  hidden = false
  dataset: Record<string, string> = {}
  className = ""
  textContent = ""
  scrollTop = 0
  htmlWrites = 0
  private html = ""
  readonly attributes = new Map<string, string>()
  readonly classes = new Set<string>()
  readonly classList = {
    toggle: (name: string, enabled: boolean): void => {
      if (enabled) this.classes.add(name)
      else this.classes.delete(name)
    },
  }

  get innerHTML(): string { return this.html }
  set innerHTML(value: string) { this.html = value; this.htmlWrites++ }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
}

function fixture() {
  const elements = new Map([
    '[data-view="bubble"]', ".pet-button", '[data-view="pet"]', ".badge", ".dot",
    '[data-view="connection"]', ".panel", ".panel-body", '[data-tab="tasks"]',
    '[data-tab="settings"]', '[data-view="tasks-content"]', '[data-view="settings-content"]', ".toast",
  ].map((selector) => [selector, new ViewElement()]))
  const root = Object.assign(new ViewElement(), {
    querySelector: (selector: string) => elements.get(selector) ?? null,
  })
  return {
    root,
    update: mountPetView(root as unknown as HTMLElement),
    element: (selector: string) => elements.get(selector)!,
  }
}

const initial: PetView = {
  mood: "idle", bubble: "准备好啦", panelOpen: false, pending: 0,
  petMarkup: '<svg aria-label="桌宠"></svg>', connectionClass: "online",
  connectionText: "1/1 已连接", tab: "tasks", taskCount: 1,
  panelMarkup: '<article class="session-card">任务 A</article>', toast: "", toastError: false,
}

describe("stable pet view", () => {
  test("repeated snapshots never remount animated containers or unchanged content", () => {
    const view = fixture()
    for (let i = 0; i < 20; i++) view.update({ ...initial })
    expect(view.root.htmlWrites).toBe(1)
    expect(view.element('[data-view="pet"]').htmlWrites).toBe(1)
    expect(view.element(".panel-body").htmlWrites).toBe(1)
    expect(view.element('[data-view="bubble"]').htmlWrites).toBe(0)
    expect(view.element(".panel").htmlWrites).toBe(0)
    expect(view.element(".toast").htmlWrites).toBe(0)
    expect(view.root.innerHTML).toContain('class="fx-layer"')
  })

  test("real task updates change text and controls without restarting bubble or pet nodes", () => {
    const view = fixture()
    view.update(initial)
    view.update({ ...initial, mood: "permission", bubble: "1 项操作等你确认", pending: 1, taskCount: 2, panelMarkup: "待授权" })
    expect(view.element('[data-view="bubble"]').textContent).toBe("1 项操作等你确认")
    expect(view.element(".pet-button").dataset.state).toBe("permission")
    expect(view.element(".badge").hidden).toBe(false)
    expect(view.element(".badge").textContent).toBe("1")
    expect(view.element('[data-tab="tasks"]').textContent).toBe("任务 2")
    expect(view.element(".panel-body").htmlWrites).toBe(2)
    expect(view.element('[data-view="pet"]').htmlWrites).toBe(1)
    expect(view.root.htmlWrites).toBe(1)
  })

  test("panel and toast show/hide in place, including literal untrusted notification text", () => {
    const view = fixture()
    const message = '<img src=x onerror="alert(1)">'
    view.update({ ...initial, panelOpen: true, toast: message, toastError: true })
    expect(view.element(".panel").hidden).toBe(false)
    expect(view.element('[data-view="bubble"]').hidden).toBe(true)
    expect(view.element(".toast").hidden).toBe(false)
    expect(view.element(".toast").textContent).toBe(message)
    expect(view.element(".toast").classes.has("error")).toBe(true)
    view.update(initial)
    expect(view.element(".panel").hidden).toBe(true)
    expect(view.element(".toast").hidden).toBe(true)
    expect(view.element(".toast").classes.has("error")).toBe(false)
    expect(view.root.htmlWrites).toBe(1)
  })

  test("persistent task and settings panes are never replaced during streaming snapshots", () => {
    const view = fixture()
    const { panelMarkup: _, ...persistent } = initial
    view.update({ ...persistent, panelOpen: true, tab: "settings" })
    for (let count = 1; count <= 25; count++) view.update({ ...persistent, tab: "settings", taskCount: count })
    expect(view.element(".panel-body").htmlWrites).toBe(0)
    expect(view.element('[data-view="tasks-content"]').hidden).toBe(true)
    expect(view.element('[data-view="settings-content"]').hidden).toBe(false)
    view.update({ ...persistent, tab: "tasks" })
    expect(view.element('[data-view="tasks-content"]').hidden).toBe(false)
    expect(view.element(".panel-body").htmlWrites).toBe(0)
  })

  test("switching tabs keeps each pane's own scroll position", () => {
    const view = fixture()
    const { panelMarkup: _, ...persistent } = initial
    view.update({ ...persistent, panelOpen: true })
    view.element(".panel-body").scrollTop = 230
    view.update({ ...persistent, panelOpen: true, tab: "settings" })
    expect(view.element(".panel-body").scrollTop).toBe(0)
    view.element(".panel-body").scrollTop = 470
    view.update({ ...persistent, panelOpen: true, tab: "tasks" })
    expect(view.element(".panel-body").scrollTop).toBe(230)
    view.update({ ...persistent, panelOpen: true, tab: "settings" })
    expect(view.element(".panel-body").scrollTop).toBe(470)
  })
})
