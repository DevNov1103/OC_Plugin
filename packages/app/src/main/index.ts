import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
  type MenuItemConstructorOptions,
} from "electron"
import { isPermissionResponse, type PermissionResponse } from "@opencode-pet/protocol"
import { InstanceHub } from "./instances"
import { DragController } from "./drag"
import { boundsForWindowLayout, PANEL_WINDOW_SIZE, positionForWindowSize } from "./window-layout"
import { SettingsStore, parseSettingsUpdate, type StoredSettings, type WindowPosition } from "./settings"
import { NotificationController, type PetAlert } from "./notifications"
import { ShortcutController } from "./shortcuts"
import { loadSkin } from "./skin"
import {
  IPC_CHANNELS,
  parseInteractiveRegions,
  parseDragGesture,
  parseWindowLayout,
  pointIsInInteractiveRegion,
  type AppEvent,
  type AppSnapshot,
  type AppDiagnostics,
  type DragState,
  type InteractiveRegion,
  type PetSettings,
  type PetWindowLayout,
  type SettingsUpdate,
  type SkinPackage,
  type WindowAction,
} from "../shared/ipc"

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const WINDOW_WIDTH = PANEL_WINDOW_SIZE.width
const WINDOW_HEIGHT = PANEL_WINDOW_SIZE.height
const WINDOW_MARGIN = 24
const HIT_TEST_INTERVAL = 80

// Status sounds are part of the notification contract and must also work
// before the user has clicked the transparent window.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")

// Development-only isolated profiles let sustained-load tests avoid real settings and OpenCode instances.
const validationDirectory = !app.isPackaged && process.env.OPENCODE_PET_VALIDATION_DIR && isAbsolute(process.env.OPENCODE_PET_VALIDATION_DIR)
  ? process.env.OPENCODE_PET_VALIDATION_DIR : undefined
if (validationDirectory) app.setPath("userData", validationDirectory)

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let instanceHub: InstanceHub | null = null
let settingsStore: SettingsStore | null = null
let rendererReady = false
let quitting = false
let moveTimer: NodeJS.Timeout | undefined
let hitTestTimer: NodeJS.Timeout | undefined
let interactiveRegions: InteractiveRegion[] = []
let appliedClickThrough: boolean | undefined
let dragController: DragController | null = null
let pendingWindowLayout: PetWindowLayout | null = null
let activeSettings: StoredSettings | null = null
let shortcutController: ShortcutController | null = null
let shortcutError = ""
let notificationController: NotificationController | null = null
let cachedSkin: SkinPackage | null = null
let cachedSkinPath: string | null = null
let dndTimer: NodeJS.Timeout | undefined
let settingsUpdateQueue: Promise<unknown> = Promise.resolve()
let pendingUiAction: "open-tasks" | "open-settings" | null = null

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "tray.png")
    : join(app.getAppPath(), "resources", "tray.png")
}

function safeWindowPosition(position: WindowPosition | null): WindowPosition {
  if (position) {
    const visible = screen.getAllDisplays().some(({ workArea }) => (
      position.x < workArea.x + workArea.width - 40
      && position.x + WINDOW_WIDTH > workArea.x + 40
      && position.y < workArea.y + workArea.height - 40
      && position.y + WINDOW_HEIGHT > workArea.y + 40
    ))
    if (visible) return position
  }

  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - WINDOW_WIDTH - WINDOW_MARGIN,
    y: workArea.y + workArea.height - WINDOW_HEIGHT - WINDOW_MARGIN,
  }
}

function preloadPath(): string {
  return join(currentDirectory, "../preload/index.cjs")
}

function sendSnapshot(snapshot = instanceHub?.getSnapshot()): void {
  if (!snapshot || !rendererReady || !mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return
  mainWindow.webContents.send(IPC_CHANNELS.snapshot, snapshot)
}

function sendEvent(event: AppEvent): void {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.notify, event)
  }
  if (event.type === "notify") notificationController?.push(event.instanceId, event.instanceLabel, event.event)
}

function sendDragState(state: DragState): void {
  if (state.phase === "settled" && pendingWindowLayout) applyWindowLayout(pendingWindowLayout)
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.dragState, state)
  }
}

function applyWindowLayout(layout: PetWindowLayout): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (dragController?.isActive()) {
    pendingWindowLayout = layout
    return
  }
  pendingWindowLayout = null
  const current = mainWindow.getBounds()
  const next = boundsForWindowLayout(current, layout, screen.getAllDisplays().map(({ workArea }) => workArea))
  if (current.width === next.width && current.height === next.height) return
  // Old rectangles no longer match after resize; the renderer reports fresh ones on the next frame.
  interactiveRegions = []
  mainWindow.setBounds(next)
  syncHitTesting(activeSettings?.clickThrough ?? false)
  persistWindowPosition()
}

function presentAlert(alert: PetAlert): void {
  sendEvent({ type: "alert", kind: alert.kind, title: alert.title, message: alert.message, count: alert.count, sound: alert.sound })
  if (!alert.popup || !Notification.isSupported()) return
  const notification = new Notification({
    title: alert.title,
    body: alert.message,
    icon: iconPath(),
    // The renderer owns the one configurable sound, preventing double playback by Windows.
    silent: true,
  })
  notification.on("click", () => openPanel("open-tasks"))
  notification.show()
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.showInactive()
  mainWindow.moveTop()
}

function openPanel(action: "open-tasks" | "open-settings"): void {
  showWindow()
  if (rendererReady) sendEvent({ type: "ui-action", action })
  else pendingUiAction = action
}

function toggleWindow(): void {
  if (mainWindow?.isVisible() && !mainWindow.isMinimized()) mainWindow.hide()
  else showWindow()
}

function applyClickThrough(value: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (appliedClickThrough === value) return
  mainWindow.setIgnoreMouseEvents(value, { forward: true })
  appliedClickThrough = value
}

function cursorIsInInteractiveRegion(): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return false
  const cursor = screen.getCursorScreenPoint()
  const bounds = mainWindow.getContentBounds()
  const x = cursor.x - bounds.x
  const y = cursor.y - bounds.y
  return pointIsInInteractiveRegion({ x, y }, interactiveRegions)
}

function pollInteractiveRegions(): void {
  if (dragController?.isActive()) {
    applyClickThrough(false)
    return
  }
  if (!activeSettings?.clickThrough || interactiveRegions.length === 0) return
  applyClickThrough(!cursorIsInInteractiveRegion())
}

function stopHitTestPolling(): void {
  if (hitTestTimer) clearInterval(hitTestTimer)
  hitTestTimer = undefined
}

function syncHitTesting(preferenceEnabled: boolean): void {
  stopHitTestPolling()
  if (!mainWindow?.isVisible() || mainWindow.isMinimized()) return
  // Renderer snapshots continue to report regions while a drag animation is playing.
  // Never let those reports restart click-through polling mid-drag.
  if (dragController?.isActive()) {
    applyClickThrough(false)
    return
  }
  if (!preferenceEnabled) {
    applyClickThrough(false)
    return
  }

  // Until the renderer reports its visible DOM rectangles, forward pointer
  // events through the transparent window so it can still opt back in.
  if (interactiveRegions.length === 0) {
    applyClickThrough(true)
    return
  }
  pollInteractiveRegions()
  hitTestTimer = setInterval(pollInteractiveRegions, HIT_TEST_INTERVAL)
  hitTestTimer.unref()
}

function configureAutoLaunch(value: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: value,
      path: process.execPath,
      args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"],
    })
  } catch (error) {
    console.warn("Could not update auto-launch preference", error)
  }
}

function applySettings(settings: StoredSettings): void {
  const previous = activeSettings
  activeSettings = settings
  if (settings.locked || !settings.inertia) dragController?.cancel()
  if (mainWindow && !mainWindow.isDestroyed()) {
    // The renderer scales only the pet stage, keeping its settings panel readable.
    // Applying a webContents zoom here as well would scale the UI twice.
    syncHitTesting(settings.clickThrough)
  }
  if (!validationDirectory && (!previous || previous.autoLaunch !== settings.autoLaunch)) configureAutoLaunch(settings.autoLaunch)
  if (dndTimer) clearTimeout(dndTimer)
  dndTimer = undefined
  if (settings.dndUntil > Date.now()) {
    dndTimer = setTimeout(() => { void updateSettingsAndPublish({ dndUntil: 0 }).catch(console.warn) }, settings.dndUntil - Date.now())
    dndTimer.unref()
  }
  refreshTrayMenu()
}

async function publicSettings(): Promise<PetSettings> {
  if (!settingsStore) throw new Error("Settings are not ready")
  const stored = settingsStore.get()
  let skin = null
  if (stored.skinPath) {
    try {
      if (cachedSkinPath !== stored.skinPath) {
        cachedSkin = await loadSkin(stored.skinPath)
        cachedSkinPath = stored.skinPath
      }
      skin = cachedSkin
    } catch (error) {
      console.warn("Could not load the selected pet skin", error)
    }
  }
  const { skinPath: _skinPath, windowPosition: _position, ...preferences } = stored
  return {
    ...preferences,
    ...(stored.skinPath ? { skinPath: stored.skinPath } : {}),
    skin,
    ...(shortcutError ? { shortcutError } : {}),
  }
}

function updateSettingsAndPublish(update: SettingsUpdate): Promise<PetSettings> {
  const request = settingsUpdateQueue.catch(() => undefined).then(async () => {
    if (!settingsStore) throw new Error("Settings are not ready")
    const parsed = parseSettingsUpdate(update)
    const previous = settingsStore.get()
    if (parsed.shortcuts) shortcutController?.configure(parsed.shortcuts)
    let next: StoredSettings
    try { next = await settingsStore.update(parsed) }
    catch (error) {
      if (parsed.shortcuts) shortcutController?.configure(previous.shortcuts)
      throw error
    }
    if (parsed.shortcuts) shortcutError = ""
    applySettings(next)
    const published = await publicSettings()
    sendEvent({ type: "settings.changed", settings: published })
    return published
  })
  settingsUpdateQueue = request
  return request
}

function changeFromMenu(update: SettingsUpdate): void {
  void updateSettingsAndPublish(update).catch((error: unknown) => {
    console.warn("Could not update preference", error)
    dialog.showErrorBox("设置未保存", error instanceof Error ? error.message : String(error))
  })
}

function commonMenu(): MenuItemConstructorOptions[] {
  const settings = activeSettings ?? settingsStore?.get()
  if (!settings) return []
  const quiet = settings.dndUntil > Date.now()
  return [
    { label: "查看任务", click: () => openPanel("open-tasks") },
    { label: "设置", click: () => openPanel("open-settings") },
    { type: "separator" },
    { label: "锁定位置", type: "checkbox", checked: settings.locked, click: (item) => changeFromMenu({ locked: item.checked }) },
    { label: "甩动惯性", type: "checkbox", checked: settings.inertia, click: (item) => changeFromMenu({ inertia: item.checked }) },
    { label: "低功耗", type: "checkbox", checked: settings.lowPower, click: (item) => changeFromMenu({ lowPower: item.checked }) },
    { label: quiet ? "恢复通知" : "免打扰 30 分钟", click: () => changeFromMenu({ dndUntil: quiet ? 0 : Date.now() + 30 * 60_000 }) },
    { label: "鼠标穿透", type: "checkbox", checked: settings.clickThrough, click: (item) => changeFromMenu({ clickThrough: item.checked }) },
  ]
}

function refreshTrayMenu(): void {
  if (!tray || !settingsStore) return
  const settings = activeSettings ?? settingsStore.get()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示桌宠", click: () => showWindow() },
    { label: "隐藏桌宠", click: () => mainWindow?.hide() },
    { type: "separator" },
    ...commonMenu(),
    {
      label: "开机启动",
      type: "checkbox",
      checked: settings.autoLaunch,
      click: (item) => {
        changeFromMenu({ autoLaunch: item.checked })
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]))
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }))
  tray.setToolTip("OpenCode Pet")
  tray.on("click", () => {
    toggleWindow()
  })
  refreshTrayMenu()
}

function persistWindowPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !settingsStore) return
  if (moveTimer) clearTimeout(moveTimer)
  moveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !settingsStore) return
    const bounds = mainWindow.getBounds()
    // Store the bottom-centre anchor in the original panel-size coordinate system.
    // Starting with a compact saved top-left would otherwise move the pet on every restart.
    void settingsStore.setWindowPosition(positionForWindowSize(bounds, PANEL_WINDOW_SIZE))
  }, 250)
}

async function createWindow(): Promise<void> {
  if (!settingsStore) throw new Error("Settings are not ready")
  const settings = settingsStore.get()
  const position = safeWindowPosition(settings.windowPosition)
  const options: BrowserWindowConstructorOptions = {
    x: position.x,
    y: position.y,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  }

  mainWindow = new BrowserWindow(options)
  mainWindow.setAlwaysOnTop(true, "floating")
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("context-menu", () => {
    if (mainWindow && !mainWindow.isDestroyed()) Menu.buildFromTemplate([
      ...commonMenu(), { type: "separator" },
      { label: "隐藏桌宠", click: () => mainWindow?.hide() },
      { label: "退出", click: () => app.quit() },
    ]).popup({ window: mainWindow })
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true
    sendSnapshot()
    if (pendingUiAction) {
      sendEvent({ type: "ui-action", action: pendingUiAction })
      pendingUiAction = null
    }
  })
  mainWindow.on("move", persistWindowPosition)
  const shown = (): void => {
    sendEvent({ type: "visibility", visible: true })
    syncHitTesting(activeSettings?.clickThrough ?? true)
    sendSnapshot()
  }
  const hidden = (): void => {
    dragController?.cancel()
    stopHitTestPolling()
    sendEvent({ type: "visibility", visible: false })
  }
  mainWindow.on("show", shown)
  mainWindow.on("restore", shown)
  mainWindow.on("hide", hidden)
  mainWindow.on("minimize", hidden)
  mainWindow.on("close", (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on("closed", () => {
    dragController?.cancel()
    stopHitTestPolling()
    interactiveRegions = []
    appliedClickThrough = undefined
    rendererReady = false
    pendingWindowLayout = null
    mainWindow = null
  })

  applySettings(settings)

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) await mainWindow.loadURL(rendererUrl)
  else await mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"))

  if (!process.argv.includes("--hidden")) showWindow()
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function isWindowAction(value: unknown): value is WindowAction {
  return value === "show"
    || value === "hide"
    || value === "toggle"
    || value === "minimize"
    || value === "close"
    || value === "quit"
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.replyPermission,
    (_event, instanceId: unknown, sessionID: unknown, permissionID: unknown, response: unknown) => {
      if (!isPermissionResponse(response)) throw new TypeError("Invalid permission response")
      instanceHub?.replyPermission(
        requireNonEmptyString(instanceId, "instanceId"),
        requireNonEmptyString(sessionID, "sessionID"),
        requireNonEmptyString(permissionID, "permissionID"),
        response as PermissionResponse,
      )
    },
  )

  ipcMain.handle(IPC_CHANNELS.setClickThrough, async (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new TypeError("Click-through value must be a boolean")
    if (dragController?.isActive()) {
      applyClickThrough(false)
      return
    }
    applyClickThrough(value)
  })

  ipcMain.handle(IPC_CHANNELS.setInteractiveRegions, async (_event, value: unknown) => {
    interactiveRegions = parseInteractiveRegions(value)
    syncHitTesting(activeSettings?.clickThrough ?? false)
  })

  ipcMain.handle(IPC_CHANNELS.setWindowLayout, (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("Only the pet renderer may resize its window")
    applyWindowLayout(parseWindowLayout(value))
  })

  ipcMain.handle(IPC_CHANNELS.getSettings, () => publicSettings())
  ipcMain.handle(IPC_CHANNELS.getDiagnostics, (event): AppDiagnostics => {
    if (event.sender !== mainWindow?.webContents) throw new Error("Only the pet renderer may inspect metrics")
    const snapshot = instanceHub?.getSnapshot()
    return {
      uptimeSeconds: process.uptime(), sessionCount: snapshot?.sessions.length ?? 0, connectionCount: snapshot?.connections.length ?? 0,
      processes: app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
        pid, type, cpuPercent: cpu.percentCPUUsage,
        workingSetMB: memory.workingSetSize / 1024, privateMB: (memory.privateBytes ?? memory.workingSetSize) / 1024,
      })),
    }
  })

  ipcMain.handle(IPC_CHANNELS.updateSettings, async (_event, value: unknown) => {
    return updateSettingsAndPublish(parseSettingsUpdate(value))
  })

  ipcMain.handle(IPC_CHANNELS.chooseSkin, async () => {
    if (!settingsStore) throw new Error("Settings are not ready")
    const options: OpenDialogOptions = {
      title: "选择桌宠皮肤的 pet.json",
      properties: ["openFile"],
      filters: [{ name: "Pet skin manifest", extensions: ["json"] }],
    }
    const selection = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths[0]) return null
    const skin = await loadSkin(selection.filePaths[0])
    await settingsStore.setSkinPath(skin.manifestPath)
    cachedSkin = skin
    cachedSkinPath = skin.manifestPath
    return skin
  })

  ipcMain.handle(IPC_CHANNELS.windowAction, (_event, action: unknown) => {
    if (!isWindowAction(action)) throw new TypeError("Invalid window action")
    switch (action) {
      case "show":
        showWindow()
        break
      case "hide":
      case "close":
        mainWindow?.hide()
        break
      case "toggle":
        toggleWindow()
        break
      case "minimize":
        mainWindow?.minimize()
        break
      case "quit":
        app.quit()
        break
    }
  })

  ipcMain.handle(IPC_CHANNELS.dragStart, (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("Only the pet renderer may start a drag")
    const gesture = parseDragGesture(value)
    if (!activeSettings?.locked) dragController?.start(gesture)
  })

  ipcMain.handle(IPC_CHANNELS.dragEnd, (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("Only the pet renderer may end a drag")
    dragController?.end(parseDragGesture(value))
  })
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("com.opencode.pet")
  settingsStore = new SettingsStore(join(app.getPath("userData"), "settings.json"))
  await settingsStore.load()
  shortcutController = new ShortcutController(globalShortcut, { toggle: toggleWindow, tasks: () => openPanel("open-tasks") })
  try { shortcutController.configure(settingsStore.get().shortcuts) }
  catch (error) { shortcutError = error instanceof Error ? error.message : String(error) }
  notificationController = new NotificationController(() => activeSettings ?? settingsStore!.get(), presentAlert)
  dragController = new DragController({
    getWindow: () => mainWindow,
    getCursor: () => screen.getCursorScreenPoint(),
    getWorkAreas: () => screen.getAllDisplays().map(({ workArea }) => ({ ...workArea })),
    stopHitTestPolling,
    applyClickThrough,
    syncHitTesting,
    clickThroughEnabled: () => activeSettings?.clickThrough ?? false,
    inertiaEnabled: () => activeSettings?.inertia ?? true,
    persistWindowPosition,
    sendState: sendDragState,
  })
  registerIpcHandlers()
  await createWindow()
  createTray()

  instanceHub = new InstanceHub(validationDirectory ? join(validationDirectory, "instances") : join(homedir(), ".opencode-pet", "instances"), {
    onSnapshot: (snapshot: AppSnapshot) => sendSnapshot(snapshot),
    onEvent: (event: AppEvent) => sendEvent(event),
  })
  await instanceHub.start()
  sendSnapshot()
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", () => showWindow())
  app.on("before-quit", (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (moveTimer) clearTimeout(moveTimer)
    dragController?.cancel()
    if (moveTimer) clearTimeout(moveTimer)
    stopHitTestPolling()
    instanceHub?.stop()
    shortcutController?.dispose()
    notificationController?.dispose()
    if (dndTimer) clearTimeout(dndTimer)
    const window = mainWindow
    const save = settingsStore && window && !window.isDestroyed()
      ? settingsStore.setWindowPosition(positionForWindowSize(window.getBounds(), PANEL_WINDOW_SIZE))
      : Promise.resolve()
    void save.catch(console.warn).finally(() => app.quit())
  })
  app.on("window-all-closed", () => {
    // The tray owns the app lifetime; closing the pet window only hides it.
  })
  app.on("activate", () => {
    if (mainWindow) showWindow()
    else void createWindow()
  })

  void app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error("Could not start OpenCode Pet", error)
    dialog.showErrorBox("OpenCode Pet", error instanceof Error ? error.message : String(error))
    app.quit()
  })
}
