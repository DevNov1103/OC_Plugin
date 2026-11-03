export interface PetView {
  mood: string
  bubble: string
  panelOpen: boolean
  pending: number
  petMarkup: string
  connectionClass: string
  connectionText: string
  tab: "tasks" | "settings"
  taskCount: number
  panelMarkup?: string
  toast: string
  toastError: boolean
}

/** Keep animated containers mounted: status updates must not replay entrance animations. */
export function mountPetView(root: HTMLElement): (view: PetView) => void {
  root.innerHTML = `<main class="shell">
    <div class="window-actions">
      <button class="icon-button" data-action="minimize" aria-label="最小化">−</button>
      <button class="icon-button" data-action="settings" aria-label="设置">⚙</button>
      <button class="icon-button" data-action="close" aria-label="关闭">×</button>
    </div>
    <section class="stage">
      <div class="bubble" data-view="bubble"></div>
      <button class="pet-button" data-action="toggle-panel" aria-label="打开任务面板" aria-expanded="false">
        <span class="pet-content" data-view="pet"></span>
        <span class="badge" hidden></span>
      </button>
      <div class="status-pill"><i class="dot"></i><span data-view="connection"></span></div>
    </section>
    <section class="panel" hidden aria-label="桌宠面板">
      <header class="panel-head"><h1>OpenCode 桌宠</h1><nav class="panel-tabs"><button class="tab" data-tab="tasks"></button><button class="tab" data-tab="settings">设置</button><button class="tab" data-action="close-panel" aria-label="收起面板">收起</button></nav></header>
      <div class="panel-body"><div data-view="tasks-content"></div><div data-view="settings-content" hidden></div></div>
    </section>
    <div class="fx-layer" aria-hidden="true"></div>
    <div class="toast" hidden></div>
  </main>`

  function element(selector: string): HTMLElement {
    const result = root.querySelector<HTMLElement>(selector)
    if (!result) throw new Error(`Missing pet view element: ${selector}`)
    return result
  }

  const bubble = element('[data-view="bubble"]')
  const petButton = element(".pet-button")
  const pet = element('[data-view="pet"]')
  const badge = element(".badge")
  const dot = element(".dot")
  const connection = element('[data-view="connection"]')
  const panel = element(".panel")
  const panelBody = element(".panel-body")
  const tasksContent = element('[data-view="tasks-content"]')
  const settingsContent = element('[data-view="settings-content"]')
  const tasksTab = element('[data-tab="tasks"]')
  const settingsTab = element('[data-tab="settings"]')
  const toast = element(".toast")
  let petMarkup: string | undefined
  let panelMarkup: string | undefined
  let selectedTab: PetView["tab"] = "tasks"
  const scrollPositions = { tasks: 0, settings: 0 }

  function setText(target: HTMLElement, value: string): void {
    if (target.textContent !== value) target.textContent = value
  }

  return (view): void => {
    let restoreScroll: number | undefined
    if (selectedTab !== view.tab) {
      scrollPositions[selectedTab] = panelBody.scrollTop || 0
      selectedTab = view.tab
      restoreScroll = scrollPositions[selectedTab]
    }
    setText(bubble, view.bubble)
    bubble.hidden = view.panelOpen
    petButton.dataset.state = view.mood
    petButton.setAttribute("aria-expanded", String(view.panelOpen))
    if (petMarkup !== view.petMarkup) {
      pet.innerHTML = view.petMarkup
      petMarkup = view.petMarkup
    }
    badge.hidden = !view.pending
    setText(badge, view.pending > 99 ? "99+" : String(view.pending))
    dot.className = `dot ${view.connectionClass}`.trim()
    setText(connection, view.connectionText)
    panel.hidden = !view.panelOpen
    tasksTab.classList.toggle("active", view.tab === "tasks")
    settingsTab.classList.toggle("active", view.tab === "settings")
    setText(tasksTab, `任务 ${view.taskCount}`)
    tasksContent.hidden = view.tab !== "tasks"
    settingsContent.hidden = view.tab !== "settings"
    if (restoreScroll !== undefined) panelBody.scrollTop = restoreScroll
    if (view.panelMarkup !== undefined && panelMarkup !== view.panelMarkup) {
      panelBody.innerHTML = view.panelMarkup
      panelMarkup = view.panelMarkup
    }
    setText(toast, view.toast)
    toast.classList.toggle("error", view.toastError)
    toast.hidden = !view.toast
  }
}
