import type { TaskPreferences } from "../shared/ipc"

export const TASK_PAGE_SIZE = 50

/** Retrying sessions and live tool activity still count as running, even before status catches up. */
export function isRunningTask(session: { state?: unknown; status?: unknown; activity?: unknown; session?: unknown }): boolean {
  const nested = session.session && typeof session.session === "object" ? session.session as Record<string, unknown> : {}
  const status = String(session.state ?? session.status ?? nested.status ?? "idle").toLowerCase()
  if (/busy|working|running|stream|tool|thinking|active|retry|reconnect/.test(status)) return true
  const activity = session.activity && typeof session.activity === "object" ? session.activity as Record<string, unknown> : {}
  return typeof activity.tool === "string" && activity.tool.trim().length > 0
}

export interface TaskItem {
  key: string
  pinKey: string
  project: string
  priority: number
  updatedAt: number
  busy: boolean
  permission: boolean
  error: boolean
  completed: boolean
}

export function persistentTaskKey(directory: string, sessionID: string): string {
  return JSON.stringify([directory, sessionID])
}

export function taskMatches(item: TaskItem, preferences: TaskPreferences): boolean {
  if (preferences.project && item.project !== preferences.project) return false
  if (preferences.status === "busy") return item.busy
  if (preferences.status === "permission") return item.permission
  if (preferences.status === "error") return item.error
  return true
}

export function selectTaskPage<T extends TaskItem>(
  items: readonly T[], preferences: TaskPreferences, pinned: ReadonlySet<string>, limit = TASK_PAGE_SIZE,
): { active: T[]; completed: T[]; completedCount: number; matched: number; more: boolean } {
  const matched = items.filter((item) => taskMatches(item, preferences)).sort((a, b) => (
    Number(pinned.has(b.pinKey)) - Number(pinned.has(a.pinKey))
    || b.priority - a.priority || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)
  ))
  const active = matched.filter((item) => !item.completed || pinned.has(item.pinKey))
  const completed = matched.filter((item) => item.completed && !pinned.has(item.pinKey))
  const activePage = active.slice(0, limit)
  const completedPage = preferences.collapseCompleted ? [] : completed.slice(0, Math.max(0, limit - activePage.length))
  const available = active.length + (preferences.collapseCompleted ? 0 : completed.length)
  return { active: activePage, completed: completedPage, completedCount: completed.length, matched: matched.length, more: available > limit }
}

export function projectLabel(directory: string): string {
  const segments = directory.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || directory || "未命名项目"
}

interface TaskViewOptions<T extends TaskItem> {
  onPreferences(preferences: TaskPreferences): void
  onMore(): void
  renderCard(item: T): string
}

/** The filters and list stay mounted; only cards whose displayed content changed are patched. */
export function mountTaskView<T extends TaskItem>(container: HTMLElement, options: TaskViewOptions<T>) {
  container.innerHTML = `<div class="task-filters">
    <label>项目<select data-task-filter="project" aria-label="按项目筛选任务"><option value="">全部项目</option></select></label>
    <label>状态<select data-task-filter="status" aria-label="按状态筛选任务"><option value="all">全部状态</option><option value="busy">运行中</option><option value="permission">待授权</option><option value="error">有错误</option></select></label>
  </div><div class="task-summary" aria-live="polite"></div><div class="task-active-list"></div>
  <details class="completed-tasks"><summary></summary><div class="task-completed-list"></div></details>
  <div class="empty" hidden>暂无符合条件的任务</div><button class="wide-button task-more" type="button" hidden>再显示 50 个任务</button>`
  const project = container.querySelector<HTMLSelectElement>('[data-task-filter="project"]')!
  const status = container.querySelector<HTMLSelectElement>('[data-task-filter="status"]')!
  const summary = container.querySelector<HTMLElement>(".task-summary")!
  const activeList = container.querySelector<HTMLElement>(".task-active-list")!
  const completedList = container.querySelector<HTMLElement>(".task-completed-list")!
  const details = container.querySelector<HTMLDetailsElement>(".completed-tasks")!
  const completedSummary = details.querySelector<HTMLElement>("summary")!
  const empty = container.querySelector<HTMLElement>(".empty")!
  const more = container.querySelector<HTMLButtonElement>(".task-more")!
  const cards = new Map<string, { element: HTMLElement; markup: string }>()
  let preferences: TaskPreferences = { project: "", status: "all", collapseCompleted: true }
  let projectKey = ""

  container.addEventListener("change", (event) => {
    const control = event.target as HTMLSelectElement
    if (control !== project && control !== status) return
    options.onPreferences({ ...preferences, [control.dataset.taskFilter!]: control.value })
  })
  details.addEventListener("toggle", () => {
    if (details.open === !preferences.collapseCompleted) return
    options.onPreferences({ ...preferences, collapseCompleted: !details.open })
  })
  more.addEventListener("click", options.onMore)

  function patchList(list: HTMLElement, items: T[], keep: Set<string>): void {
    let cursor = list.firstElementChild
    for (const item of items) {
      keep.add(item.key)
      const markup = options.renderCard(item)
      let cached = cards.get(item.key)
      if (!cached) {
        const element = document.createElement("article")
        element.className = "session-card"
        cached = { element, markup: "" }
        cards.set(item.key, cached)
      }
      if (cached.markup !== markup) {
        cached.element.innerHTML = markup
        cached.markup = markup
      }
      if (cached.element !== cursor) list.insertBefore(cached.element, cursor)
      cursor = cached.element.nextElementSibling
    }
  }

  return (items: T[], nextPreferences: TaskPreferences, pinned: ReadonlySet<string>, limit: number): void => {
    preferences = nextPreferences
    const directories = [...new Set(items.map((item) => item.project).filter(Boolean))].sort()
    if (preferences.project && !directories.includes(preferences.project)) directories.push(preferences.project)
    const nextProjectKey = JSON.stringify(directories)
    if (nextProjectKey !== projectKey) {
      const fragment = document.createDocumentFragment()
      for (const directory of ["", ...directories]) {
        const option = document.createElement("option")
        option.value = directory
        option.textContent = directory ? projectLabel(directory) : "全部项目"
        option.title = directory
        fragment.appendChild(option)
      }
      project.replaceChildren(fragment)
      projectKey = nextProjectKey
    }
    if (project.value !== preferences.project) project.value = preferences.project
    if (status.value !== preferences.status) status.value = preferences.status
    const page = selectTaskPage(items, preferences, pinned, limit)
    const keep = new Set<string>()
    patchList(activeList, page.active, keep)
    patchList(completedList, page.completed, keep)
    for (const [key, card] of cards) {
      if (keep.has(key)) continue
      card.element.remove()
      cards.delete(key)
    }
    details.hidden = page.completedCount === 0
    if (details.open !== !preferences.collapseCompleted) details.open = !preferences.collapseCompleted
    completedSummary.textContent = `空闲与已完成 · ${page.completedCount}`
    summary.textContent = `符合条件 ${page.matched} / 全部 ${items.length}`
    empty.hidden = page.matched !== 0
    more.hidden = !page.more
  }
}
