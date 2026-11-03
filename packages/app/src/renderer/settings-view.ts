import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SHORTCUTS,
  DEFAULT_TASK_PREFERENCES,
  type NotificationKind,
  type NotificationPreferences,
  type ShortcutPreferences,
} from "../shared/ipc"

export function notificationPreferences(value?: NotificationPreferences): NotificationPreferences {
  return Object.fromEntries(Object.entries(DEFAULT_NOTIFICATIONS).map(([kind, rule]) => [
    kind, { ...rule, ...value?.[kind as NotificationKind] },
  ])) as NotificationPreferences
}

export function normalizeClientSettings(value: PetSettings): PetSettings {
  return {
    ...value,
    scale: Number(value.scale) || 1,
    autoLaunch: value.autoLaunch ?? value.autostart ?? false,
    clickThrough: value.clickThrough !== false,
    locked: value.locked === true,
    inertia: value.inertia !== false,
    lowPower: value.lowPower === true,
    pinnedSessions: Array.isArray(value.pinnedSessions) ? value.pinnedSessions : [],
    taskPreferences: { ...DEFAULT_TASK_PREFERENCES, ...value.taskPreferences },
    notifications: notificationPreferences(value.notifications),
    dndUntil: typeof value.dndUntil === "number" && Number.isFinite(value.dndUntil) ? value.dndUntil : 0,
    mergeNotifications: value.mergeNotifications !== false,
    shortcuts: { ...DEFAULT_SHORTCUTS, ...value.shortcuts },
  }
}

function toggle(setting: string, label: string, detail = ""): string {
  return `<label class="setting-row"><span>${label}${detail ? `<br><small>${detail}</small>` : ""}</span><span class="switch"><input data-setting="${setting}" type="checkbox"><i></i></span></label>`
}

/** Settings controls are created once, so streaming task updates cannot discard a draft or focus. */
export function mountSettingsView(container: HTMLElement) {
  container.innerHTML = `<div class="setting-card"><h2>桌宠与操作</h2>
    <label class="setting-row"><span>桌宠大小<br><small data-view="scale-label"></small></span><input data-setting="scale" type="range" min="0.65" max="1.6" step="0.05"></label>
    ${toggle("autoLaunch", "开机自启")}${toggle("clickThrough", "鼠标穿透", "透明区域可点击后方窗口")}
    ${toggle("locked", "锁定位置", "锁定后仍可点击打开面板")}${toggle("inertia", "拖拽惯性", "松手后继续滑动")}
    ${toggle("lowPower", "低功耗动画", "减少动画刷新频率")}
  </div><div class="setting-card"><h2>通知</h2>
    <div class="notification-grid notification-heading"><span>通知类型</span><span>声音</span><span>弹窗</span></div>
    ${([['task_done', '任务完成'], ['error', '任务错误'], ['permission', '待授权'], ['question', '需要回答']] as const).map(([kind, label]) => `<div class="notification-grid"><span>${label}</span>${(['sound', 'popup'] as const).map((channel) => `<label class="notification-check"><input type="checkbox" data-notify-kind="${kind}" data-notify-channel="${channel}" aria-label="${label}${channel === 'sound' ? '声音' : '弹窗'}"></label>`).join("")}</div>`).join("")}
    ${toggle("mergeNotifications", "合并连续通知", "短时间内同类提醒合并展示")}
    <div class="dnd-state" data-view="dnd-state" aria-live="polite"></div><button class="wide-button" type="button" data-action="dnd-toggle"></button>
  </div><div class="setting-card"><h2>全局快捷键</h2>
    <label class="shortcut-row"><span>显示 / 隐藏桌宠</span><input data-shortcut="toggle" type="text" spellcheck="false" placeholder="留空禁用" aria-label="显示隐藏桌宠快捷键"></label>
    <label class="shortcut-row"><span>打开任务面板</span><input data-shortcut="tasks" type="text" spellcheck="false" placeholder="留空禁用" aria-label="打开任务面板快捷键"></label>
    <p class="setting-hint">例如 Ctrl+Alt+P；留空可禁用对应快捷键。</p>
    <div class="permission-error" data-view="shortcut-error" role="status"></div><button class="wide-button" type="button" data-action="save-shortcuts">保存快捷键</button>
  </div><button class="wide-button" type="button" data-action="choose-skin">选择自定义皮肤…</button>`

  let shortcutsDirty = false
  const shortcutInputs = Array.from(container.querySelectorAll<HTMLInputElement>("[data-shortcut]"))
  for (const input of shortcutInputs) input.addEventListener("input", () => { shortcutsDirty = true })

  function update(settings: PetSettings, now = Date.now()): void {
    for (const input of Array.from(container.querySelectorAll<HTMLInputElement>("[data-setting]"))) {
      const key = input.dataset.setting!
      if (input.type === "checkbox") input.checked = Boolean(settings[key])
      else if (document.activeElement !== input) input.value = String(settings[key] ?? 1)
    }
    container.querySelector<HTMLElement>('[data-view="scale-label"]')!.textContent = `${Math.round((Number(settings.scale) || 1) * 100)}%`
    const notifications = notificationPreferences(settings.notifications)
    for (const input of Array.from(container.querySelectorAll<HTMLInputElement>("[data-notify-kind]"))) {
      input.checked = notifications[input.dataset.notifyKind as NotificationKind][input.dataset.notifyChannel as "sound" | "popup"]
    }
    const dnd = Number(settings.dndUntil) > now
    container.querySelector<HTMLElement>('[data-view="dnd-state"]')!.textContent = dnd
      ? `免打扰中，${new Date(Number(settings.dndUntil)).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 恢复；待授权角标继续显示`
      : "通知已开启；待授权角标始终显示"
    container.querySelector<HTMLButtonElement>('[data-action="dnd-toggle"]')!.textContent = dnd ? "立即恢复通知" : "免打扰 30 分钟"
    container.querySelector<HTMLElement>('[data-view="shortcut-error"]')!.textContent = settings.shortcutError || ""
    if (!shortcutsDirty) for (const input of shortcutInputs) input.value = settings.shortcuts?.[input.dataset.shortcut as keyof ShortcutPreferences] ?? ""
  }

  return {
    update,
    shortcutValues(): ShortcutPreferences {
      return Object.fromEntries(shortcutInputs.map((input) => [input.dataset.shortcut!, input.value.trim()])) as unknown as ShortcutPreferences
    },
    markShortcutsSaved(): void { shortcutsDirty = false },
  }
}
