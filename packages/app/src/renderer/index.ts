import {
  isOneShotSkinMood,
  resolveSkinAnimation,
  skinAnimationDuration,
  skinFrameAt,
  skinFramePosition,
  type ResolvedSkinAnimation,
  type SkinMood,
} from "./skin-animation"
import {
  dragDirectionForVelocity,
  dragTiltForVelocity,
  mountDragHandlers,
  type DragDirection,
} from "./drag"
import { mountPetView } from "./stable-view"
import { normalizeClientSettings, mountSettingsView } from "./settings-view"
import { isRunningTask, mountTaskView, persistentTaskKey, projectLabel, TASK_PAGE_SIZE, type TaskItem } from "./task-view"
import { DEFAULT_TASK_PREFERENCES, type DragState, type NotificationKind, type PetWindowLayout, type SettingsUpdate } from "../shared/ipc"

type PetMood = "idle" | "thinking" | "working" | "permission" | "celebrate" | "error" | "retry";
type AnyRecord = Record<string, unknown>;

interface DragVisualState extends DragState {
  direction: DragDirection
  waveUntil: number
}

const bridge = window.pet ?? window.opencodePet;

const state = {
  snapshot: { connections: [], sessions: [] } as PetSnapshot,
  settings: normalizeClientSettings({ scale: 1, autoLaunch: false, clickThrough: true }),
  windowVisible: true,
  panelOpen: false,
  tab: "tasks" as "tasks" | "settings",
  mood: "idle" as PetMood,
  bubble: "点点我，可以查看所有任务喔",
  toast: "",
  toastError: false,
  permissionErrors: new Map<string, string>(),
  replying: new Set<string>(),
  drag: {
    phase: "settled",
    vx: 0,
    vy: 0,
    direction: null,
    waveUntil: 0,
  } as DragVisualState,
};

const root = document.querySelector<HTMLDivElement>("#app")!;
const updateView = mountPetView(root);
mountDragHandlers(root, {
  isLocked: () => state.settings.locked === true,
  onDragStart(gesture) {
    if (!bridge) return;
    return bridge.dragStart(gesture);
  },
  onDragEnd(gesture) {
    if (!bridge) return;
    return bridge.dragEnd(gesture);
  },
});
let audioContext: AudioContext | undefined;
let toastTimer = 0;
let skinFrameTimer = 0;
let skinAnimationKey = "";
let skinAnimationStartedAt = 0;
let skinAnimationElement: HTMLElement | null = null;
let skinAnimationLastFrame = -1;
let regionReportRequest = 0;
let settledWaveTimer = 0;
let celebrateTimer = 0;
let dndTimer = 0;
let tasksDirty = true;
let settingsDirty = true;
let taskLimit = TASK_PAGE_SIZE;
let renderDeferred = false;
let summaryDirty = true;
let summary = { pending: 0, busy: 0, mood: "idle" as PetMood, activeConnections: 0 };
const permissionTimers = new Map<string, number>();
const permissionInstances = new Map<string, string>();
const permissionErrorTimes = new Map<string, number>();

interface RenderTaskItem extends TaskItem { session: PetSessionState }

const settingsView = mountSettingsView(root.querySelector<HTMLElement>('[data-view="settings-content"]')!);
const updateTasksView = mountTaskView<RenderTaskItem>(root.querySelector<HTMLElement>('[data-view="tasks-content"]')!, {
  onPreferences(preferences) { taskLimit = TASK_PAGE_SIZE; void updateSetting("taskPreferences", preferences); },
  onMore() { taskLimit += TASK_PAGE_SIZE; tasksDirty = true; render(); },
  renderCard: (item) => renderTaskCard(item),
});

function isVisible(): boolean { return state.windowVisible && !document.hidden; }

function applySettings(settings: PetSettings): void {
  const previous = state.settings;
  state.settings = normalizeClientSettings({ ...previous, ...settings });
  settingsDirty = true;
  if (JSON.stringify(previous.taskPreferences) !== JSON.stringify(state.settings.taskPreferences)
    || JSON.stringify(previous.pinnedSessions) !== JSON.stringify(state.settings.pinnedSessions)) tasksDirty = true;
  if (previous.lowPower !== state.settings.lowPower) {
    window.clearTimeout(skinFrameTimer);
    skinFrameTimer = 0;
  }
  window.clearTimeout(dndTimer);
  const remaining = Number(state.settings.dndUntil) - Date.now();
  if (remaining > 0) dndTimer = window.setTimeout(() => { settingsDirty = true; render(); }, Math.min(remaining + 10, 2_147_483_647));
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? value as AnyRecord : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function sessionId(session: PetSessionState): string {
  return text(session.sessionID ?? session.id, "unknown");
}

function sessionState(session: PetSessionState): string {
  const value = session.state ?? session.status ?? asRecord(session.session).status;
  return text(value, "idle").toLowerCase();
}

function isBusy(session: PetSessionState): boolean {
  return isRunningTask(session);
}

function isError(session: PetSessionState): boolean {
  return Boolean(session.error) || /error|failed|failure/.test(sessionState(session));
}

interface PermissionView {
  id: string;
  title: string;
  detail: string;
  sessionID: string;
}

function permissionsOf(session: PetSessionState): PermissionView[] {
  const raw = session.permissions ?? session.permission;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.map((item, index) => {
    const p = asRecord(item);
    return {
      id: text(p.permissionID ?? p.id, `permission-${index}`),
      title: text(p.title ?? p.type ?? p.name, "需要你的许可"),
      detail: permissionDetail(p),
      sessionID: text(p.sessionID, sessionId(session)),
    };
  }).filter((p) => p.id && p.sessionID);
}

function permissionKey(instanceId: string, sessionID: string, permissionID: string): string {
  return JSON.stringify([instanceId, sessionID, permissionID]);
}

function clearPermissionPending(key: string): void {
  state.replying.delete(key);
  tasksDirty = true;
  const timer = permissionTimers.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  permissionTimers.delete(key);
  permissionInstances.delete(key);
}

function setPermissionError(key: string, error: string): void {
  state.permissionErrors.set(key, error);
  permissionErrorTimes.set(key, Date.now());
  tasksDirty = true;
}

function clearPermissionError(key: string): void {
  state.permissionErrors.delete(key);
  permissionErrorTimes.delete(key);
}

function waitForPermissionConfirmation(key: string): void {
  const existing = permissionTimers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  permissionTimers.set(key, window.setTimeout(() => {
    if (!state.replying.has(key)) return;
    clearPermissionPending(key);
    setPermissionError(key, "确认超时；请回终端处理");
    showToast("授权确认超时，请回终端处理", true);
  }, 15_000));
}

function reconcilePendingPermissions(snapshot: PetSnapshot): void {
  const live = new Set<string>();
  for (const session of snapshot.sessions) {
    for (const permission of permissionsOf(session)) {
      live.add(permissionKey(session.instanceId, permission.sessionID, permission.id));
    }
  }
  const connected = new Set(snapshot.connections.filter((connection) => connection.connected).map((connection) => connection.id));
  for (const key of state.replying) {
    const instanceId = permissionInstances.get(key);
    if (!live.has(key) || !instanceId || !connected.has(instanceId)) clearPermissionPending(key);
  }
  for (const key of state.permissionErrors.keys()) {
    if (!live.has(key) || Date.now() - (permissionErrorTimes.get(key) ?? 0) > 5 * 60_000) clearPermissionError(key);
  }
}

function permissionDetail(permission: AnyRecord): string {
  const patterns = Array.isArray(permission.patterns)
    ? permission.patterns.map((pattern) => typeof pattern === "string" ? pattern : text(asRecord(pattern).pattern ?? asRecord(pattern).value ?? asRecord(pattern).command)).filter(Boolean)
    : [];
  return patterns.join(" · ") || text(permission.message ?? permission.detail ?? permission.description ?? permission.pattern ?? permission.command, "OpenCode 想继续执行一个受保护的操作。");
}

interface TodoView { content: string; done: boolean; current: boolean }

function todosOf(session: PetSessionState): TodoView[] {
  const raw = session.todos ?? session.todo;
  if (raw && !Array.isArray(raw) && typeof raw === "object") {
    const summary = asRecord(raw);
    const current = summary.current;
    if (current) {
      const item = asRecord(current);
      return [{ content: typeof current === "string" ? current : text(item.content ?? item.title ?? item.text, "当前任务"), done: false, current: true }];
    }
    return [];
  }
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.map((item) => {
    if (typeof item === "string") return { content: item, done: false, current: false };
    const todo = asRecord(item);
    const status = text(todo.status ?? todo.state).toLowerCase();
    return {
      content: text(todo.content ?? todo.title ?? todo.text, "任务"),
      done: bool(todo.done) || /done|complete|completed/.test(status),
      current: bool(todo.current) || /doing|progress|active|working/.test(status),
    };
  });
}

function todoSummary(session: PetSessionState): { total: number; completed: number; current: string } {
  const raw = session.todos ?? session.todo;
  if (raw && !Array.isArray(raw) && typeof raw === "object") {
    const summary = asRecord(raw);
    const total = Number(summary.total) || 0;
    const completed = Math.min(total, Number(summary.completed) || 0);
    const currentValue = summary.current;
    const currentRecord = asRecord(currentValue);
    const current = typeof currentValue === "string"
      ? currentValue
      : text(currentRecord.content ?? currentRecord.title ?? currentRecord.text);
    return { total, completed, current };
  }
  const todos = todosOf(session);
  return { total: todos.length, completed: todos.filter((todo) => todo.done).length, current: todos.find((todo) => todo.current)?.content ?? todos.find((todo) => !todo.done)?.content ?? "" };
}

function currentTool(session: PetSessionState): string {
  const activity = asRecord(session.activity);
  const tool = activity.tool ?? session.currentTool ?? session.tool ?? asRecord(session.current).tool;
  if (typeof tool === "object" && tool) return text(asRecord(tool).name ?? asRecord(tool).title, "工具调用");
  return text(tool, isBusy(session) ? "正在处理" : "等待中");
}

function activityDetail(session: PetSessionState): string {
  return text(asRecord(session.activity).detail);
}

function isThinking(session: PetSessionState): boolean {
  const value = `${sessionState(session)} ${currentTool(session)}`.toLowerCase();
  return /thinking|read|search|grep|find|list|scan|fetch|browse|web|inspect|analy/.test(value)
    && !/edit|write|patch|bash|shell|command|exec|create|delete|move/.test(value);
}

function updatedTime(session: PetSessionState): number {
  const raw = session.updatedAt ?? session.updated ?? session.timestamp ?? 0;
  const parsed = typeof raw === "number" ? raw : Date.parse(text(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function refreshSnapshotSummary(): void {
  let pending = 0, busy = 0, thinking = false, error = false, retry = false;
  for (const session of state.snapshot.sessions) {
    pending += permissionsOf(session).length;
    if (isBusy(session)) { busy++; thinking ||= isThinking(session); }
    error ||= isError(session);
    retry ||= /retry|reconnect/.test(sessionState(session));
  }
  summary = {
    pending, busy,
    mood: pending ? "permission" : error ? "error" : retry ? "retry" : busy ? (thinking ? "thinking" : "working") : "idle",
    activeConnections: state.snapshot.connections.filter((connection) => connection.connected).length,
  };
}

function moodFromSnapshot(): PetMood {
  return summary.mood === "idle" ? state.mood : summary.mood;
}

function bubbleForMood(mood: PetMood): string {
  const count = state.snapshot.sessions.length;
  const copy: Record<PetMood, string> = {
    idle: count ? `${count} 个任务都安静下来啦` : "准备好啦，随时可以开工！",
    thinking: "让我想一想…",
    working: `正在照看 ${Math.max(1, summary.busy)} 个任务`,
    permission: `${summary.pending} 项操作等你确认`,
    celebrate: "完成啦！干得漂亮 ✨",
    error: "有个任务遇到了问题",
    retry: "正在重新连接…",
  };
  return copy[mood];
}

function escapeHtml(value: unknown): string {
  return text(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}

function staticSkinSource(): string {
  const candidates = [state.settings.customSkin, state.settings.skin, state.snapshot.skin, state.snapshot.settings?.customSkin, state.snapshot.settings?.skin];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^(data:image|blob:|file:|https?:)/.test(candidate)) return candidate;
    const value = asRecord(candidate);
    const src = text(value.dataUrl ?? value.url ?? value.path ?? value.src);
    if (src && /^(data:image|blob:|file:|https?:)/.test(src)) return src;
  }
  return "";
}

function customSkinMarkup(animation: ResolvedSkinAnimation): string {
  const fit = Math.min(148 / animation.frameWidth, 148 / animation.frameHeight);
  return `<span class="custom-skin" role="img" aria-label="自定义桌宠皮肤"><span id="custom-skin-frame" class="custom-skin-frame" style="width:${animation.frameWidth}px;height:${animation.frameHeight}px;--skin-fit:${fit}"></span></span>`;
}

function startSkinAnimation(animation: ResolvedSkinAnimation | null, mood: SkinMood): void {
  if (!animation) {
    window.clearTimeout(skinFrameTimer);
    skinFrameTimer = 0;
    skinAnimationKey = "";
    skinAnimationElement = null;
    skinAnimationLastFrame = -1;
    return;
  }

  const element = document.querySelector<HTMLElement>("#custom-skin-frame");
  if (!element) return;
  const nextKey = `${animation.source}\u0000${mood}\u0000${animation.row}\u0000${animation.frames}\u0000${animation.fps}\u0000${animation.frameWidth}\u0000${animation.frameHeight}`;
  if (skinAnimationKey === nextKey && skinAnimationElement === element && skinFrameTimer) return;
  window.clearTimeout(skinFrameTimer);
  skinFrameTimer = 0;
  if (skinAnimationElement !== element || skinAnimationKey.split("\u0000")[0] !== animation.source) {
    element.style.backgroundImage = `url(${JSON.stringify(animation.source)})`;
    skinAnimationLastFrame = -1;
  }
  skinAnimationElement = element;
  if (skinAnimationKey !== nextKey) {
    skinAnimationKey = nextKey;
    skinAnimationStartedAt = performance.now();
    skinAnimationLastFrame = -1;
  }

  const playOnce = isOneShotSkinMood(mood);
  const duration = skinAnimationDuration(animation);

  const draw = (): void => {
    skinFrameTimer = 0;
    if (!element.isConnected || !isVisible()) return;
    const elapsed = performance.now() - skinAnimationStartedAt;
    const frame = skinFrameAt(animation, elapsed, !playOnce);
    if (frame !== skinAnimationLastFrame) {
      element.style.backgroundPosition = skinFramePosition(animation, frame);
      skinAnimationLastFrame = frame;
    }
    if (animation.frames > 1 && (!playOnce || elapsed < duration)) {
      const frameInterval = 1_000 / animation.fps;
      const delay = Math.max(state.settings.lowPower ? 250 : 8, frameInterval - elapsed % frameInterval + 1);
      skinFrameTimer = window.setTimeout(draw, delay);
    }
  };
  // Paint a newly selected sheet immediately, rather than leaving an empty frame.
  draw();
}

const interactiveSelectors = [".pet-button", ".bubble", ".window-actions", ".panel", ".status-pill"] as const;

function reportInteractiveRegions(): void {
  if (!bridge?.setInteractiveRegions) return;
  const regions = interactiveSelectors.flatMap((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element || element.hidden || element.closest("[hidden]")) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return [];
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    return [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
  });
  try {
    void Promise.resolve(bridge.setInteractiveRegions(regions)).catch(() => undefined);
  } catch { /* The optional M3 bridge may not be available during upgrades. */ }
}

function scheduleInteractiveRegions(): void {
  if (!isVisible()) return;
  window.cancelAnimationFrame(regionReportRequest);
  regionReportRequest = window.requestAnimationFrame(reportInteractiveRegions);
}

let layoutReportRequest = 0;
let lastLayoutKey = "";

function reportWindowLayout(): void {
  if (!bridge?.setWindowLayout) return;
  const stage = root.querySelector<HTMLElement>(".stage");
  if (!stage) return;
  const scale = Math.min(1.6, Math.max(.65, Number(state.settings.scale) || 1));
  // Use layout dimensions, not the in-progress CSS scale transition or pet tilt.
  const layout: PetWindowLayout = {
    panelOpen: state.panelOpen,
    stageWidth: Math.ceil(stage.offsetWidth * scale),
    stageHeight: Math.ceil(stage.offsetHeight * scale),
  };
  const key = JSON.stringify(layout);
  if (lastLayoutKey === key) return;
  lastLayoutKey = key;
  void Promise.resolve(bridge.setWindowLayout(layout)).then(scheduleInteractiveRegions).catch(() => {
    if (lastLayoutKey === key) lastLayoutKey = "";
  });
}

function scheduleWindowLayout(): void {
  if (!isVisible()) return;
  window.cancelAnimationFrame(layoutReportRequest);
  layoutReportRequest = window.requestAnimationFrame(reportWindowLayout);
}

function defaultPet(): string {
  return `<svg class="pet-svg" viewBox="0 0 160 160" role="img" aria-label="OpenCode 桌宠">
    <defs><linearGradient id="fur" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#c7b7ff"/><stop offset="1" stop-color="#8061de"/></linearGradient></defs>
    <path class="pet-tail" d="M117 111c28-7 31 20 15 27"/>
    <path class="pet-ear" d="M40 58 33 19c20 7 29 22 31 35z"/><path class="pet-ear" d="m99 53 25-32 7 44z"/>
    <path class="pet-ear-inner" d="m42 45-4-18c9 6 14 13 17 22z"/><path class="pet-ear-inner" d="m110 48 12-17 2 25z"/>
    <path class="pet-body" d="M36 63c9-18 27-25 48-23 24 2 41 15 44 39l4 31c3 26-15 40-48 40-34 0-55-13-52-40z"/>
    <ellipse class="pet-belly" cx="83" cy="112" rx="30" ry="26"/>
    <ellipse class="pet-eye" cx="61" cy="78" rx="5" ry="7"/><ellipse class="pet-eye" cx="104" cy="78" rx="5" ry="7"/>
    <ellipse class="pet-cheek" cx="49" cy="91" rx="8" ry="4"/><ellipse class="pet-cheek" cx="116" cy="91" rx="8" ry="4"/>
    <path class="pet-mouth" d="M74 91q9 9 18 0"/>
    <path class="pet-mark" d="m83 52 4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z"/>
  </svg>`;
}

const dragPhases = new Set<DragState["phase"]>(["picked", "dragging", "gliding", "dropping", "settled"]);

function dragAnimationMood(fallback: PetMood): SkinMood {
  switch (state.drag.phase) {
    case "picked":
      return "pickup";
    case "dragging":
    case "gliding":
      return state.drag.direction === "left"
        ? "drag-left"
        : state.drag.direction === "right"
          ? "drag-right"
          : "idle";
    case "dropping":
      return "drop";
    case "settled":
      return state.drag.waveUntil > performance.now() ? "retry" : fallback;
  }
}

function applyDragVisuals(): void {
  const petButton = document.querySelector<HTMLElement>(".pet-button");
  if (!petButton) return;
  petButton.dataset.dragPhase = state.drag.phase;
  petButton.style.setProperty("--drag-tilt", `${dragTiltForVelocity(state.drag.vx)}deg`);
}

/** Adds disposable dust particles to the persistent effect layer without rewriting it. */
function spawnDust(): void {
  const layer = root.querySelector<HTMLElement>(".fx-layer");
  const petButton = root.querySelector<HTMLElement>(".pet-button");
  if (!layer || !petButton) return;
  const rootRect = root.getBoundingClientRect();
  const petRect = petButton.getBoundingClientRect();
  for (let index = 0; index < 8; index++) {
    const particle = document.createElement("i");
    const angle = Math.PI + (index / 7 - .5) * Math.PI * .8;
    const distance = 16 + (index % 3) * 8;
    particle.className = "dust-particle";
    particle.style.left = `${petRect.left - rootRect.left + petRect.width * (.18 + (index % 5) * .15)}px`;
    particle.style.top = `${petRect.bottom - rootRect.top - 8}px`;
    particle.style.setProperty("--dust-x", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--dust-y", `${Math.sin(angle) * distance - 8}px`);
    const remove = (): void => particle.remove();
    particle.addEventListener("animationend", remove, { once: true });
    window.setTimeout(remove, 700);
    layer.appendChild(particle);
  }
}

function handleDragState(payload: unknown): void {
  const input = asRecord(payload);
  const phase = input.phase;
  const vx = input.vx;
  const vy = input.vy;
  if (typeof phase !== "string" || !dragPhases.has(phase as DragState["phase"])
    || typeof vx !== "number" || !Number.isFinite(vx) || Math.abs(vx) > 100_000
    || typeof vy !== "number" || !Number.isFinite(vy) || Math.abs(vy) > 100_000) return;

  const nextPhase = phase as DragState["phase"];
  const previous = state.drag;
  const isMoving = nextPhase === "dragging" || nextPhase === "gliding";
  const direction = isMoving ? dragDirectionForVelocity(vx, previous.direction) : null;
  window.clearTimeout(settledWaveTimer);
  const waveUntil = nextPhase === "settled" ? performance.now() + 700 : 0;
  state.drag = { phase: nextPhase, vx, vy, direction, waveUntil };

  if (previous.phase !== "dropping" && nextPhase === "dropping") spawnDust();
  if (nextPhase === "settled") {
    settledWaveTimer = window.setTimeout(() => {
      if (state.drag.phase !== "settled" || state.drag.waveUntil === 0) return;
      state.drag = { ...state.drag, waveUntil: 0 };
      render();
    }, 700);
  }

  applyDragVisuals();
  if (previous.phase !== nextPhase || previous.direction !== direction || previous.waveUntil !== waveUntil) render();
}

function render(): void {
  if (!isVisible()) { renderDeferred = true; return; }
  renderDeferred = false;
  if (summaryDirty) { refreshSnapshotSummary(); summaryDirty = false; }
  const mood = moodFromSnapshot();
  const animationMood = dragAnimationMood(mood);
  const pending = summary.pending;
  const activeConnections = summary.activeConnections;
  const totalConnections = state.snapshot.connections.length;
  const connectionClass = !totalConnections || !activeConnections ? "" : activeConnections === totalConnections ? "online" : "partial";
  const animation = resolveSkinAnimation(state.settings.skin, animationMood);
  const source = staticSkinSource();
  document.documentElement.style.setProperty("--pet-scale", String(Math.min(1.6, Math.max(.65, Number(state.settings.scale) || 1))));
  document.body.classList.toggle("position-locked", state.settings.locked === true);
  document.body.classList.toggle("low-power", state.settings.lowPower === true);

  updateView({
    mood,
    bubble: state.bubble || bubbleForMood(mood),
    panelOpen: state.panelOpen,
    pending,
    petMarkup: animation ? customSkinMarkup(animation) : source ? `<img class="custom-skin-image" src="${escapeHtml(source)}" alt="自定义桌宠皮肤">` : defaultPet(),
    connectionClass,
    connectionText: totalConnections ? `${activeConnections}/${totalConnections} 已连接` : "等待 OpenCode 连接",
    tab: state.tab,
    taskCount: state.snapshot.sessions.length,
    toast: state.toast,
    toastError: state.toastError,
  });
  if (state.panelOpen && state.tab === "tasks" && tasksDirty) {
    const connections = new Map(state.snapshot.connections.map((connection) => [connection.id, connection.directory]));
    const items: RenderTaskItem[] = state.snapshot.sessions.map((session) => {
      const project = text(session.directory) || connections.get(session.instanceId) || "";
      const pinKey = persistentTaskKey(project, sessionId(session));
      const permission = permissionsOf(session).length > 0;
      const busy = isBusy(session);
      const error = isError(session);
      return { session, project, pinKey, key: JSON.stringify([pinKey, session.instanceId]), busy, permission, error,
        priority: permission ? 4 : error ? 3 : busy ? 2 : 1, updatedAt: updatedTime(session), completed: !permission && !busy && !error };
    });
    updateTasksView(items, state.settings.taskPreferences ?? DEFAULT_TASK_PREFERENCES, new Set(state.settings.pinnedSessions), taskLimit);
    tasksDirty = false;
  }
  if (state.panelOpen && state.tab === "settings" && settingsDirty) {
    settingsView.update(state.settings);
    settingsDirty = false;
  }
  startSkinAnimation(animation, animationMood);
  applyDragVisuals();
  scheduleWindowLayout();
  scheduleInteractiveRegions();
}

function renderTaskCard(item: RenderTaskItem): string {
    const { session } = item;
    const todo = todoSummary(session);
    const percent = todo.total ? Math.round(todo.completed / todo.total * 100) : null;
    const permissions = permissionsOf(session);
    const stateName = sessionState(session);
    const chipClass = permissions.length ? "permission" : isError(session) ? "error" : "";
    const title = text(session.title ?? session.name, `会话 ${sessionId(session).slice(0, 7)}`);
    const detail = activityDetail(session);
    const pinned = state.settings.pinnedSessions?.includes(item.pinKey);
    return `<div class="session-top"><div class="session-heading"><div class="session-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div><div class="session-label" title="${escapeHtml(item.project)}">${escapeHtml(projectLabel(item.project))} · ${escapeHtml(session.instanceLabel || session.instanceId)}</div></div><button class="pin-button ${pinned ? "pinned" : ""}" type="button" data-action="pin-task" data-pin-key="${escapeHtml(item.pinKey)}" aria-pressed="${Boolean(pinned)}" aria-label="${pinned ? "取消置顶" : "置顶任务"}">${pinned ? "★" : "☆"}</button><span class="state-chip ${chipClass}">${permissions.length ? "待授权" : escapeHtml(stateName)}</span></div>
      <div class="tool">${todo.current ? `${escapeHtml(todo.current)} · ` : ""}<strong>${escapeHtml(currentTool(session))}</strong>${detail ? ` · ${escapeHtml(detail)}` : ""}</div>
      <div class="progress ${percent === null ? "unknown" : ""}"><i${percent === null ? "" : ` style="width:${Math.max(3, percent)}%"`}></i></div><div class="progress-label">${percent === null ? "进度未知" : `${todo.completed}/${todo.total} · ${percent}%`}</div>
      ${permissions.map((permission) => renderPermission(session, permission)).join("")}
    `;
}

function renderPermission(session: PetSessionState, permission: PermissionView): string {
  const key = permissionKey(session.instanceId, permission.sessionID, permission.id);
  const error = state.permissionErrors.get(key);
  const disabled = state.replying.has(key) ? "disabled" : "";
  return `<div class="permission-card"><div class="permission-title">🔐 ${escapeHtml(permission.title)}</div><div class="permission-text">${escapeHtml(permission.detail)}</div><div class="permission-actions">
    <button ${disabled} data-permission-key="${escapeHtml(key)}" data-instance="${escapeHtml(session.instanceId)}" data-session="${escapeHtml(permission.sessionID)}" data-permission="${escapeHtml(permission.id)}" data-response="once">仅一次</button>
    <button ${disabled} data-permission-key="${escapeHtml(key)}" data-instance="${escapeHtml(session.instanceId)}" data-session="${escapeHtml(permission.sessionID)}" data-permission="${escapeHtml(permission.id)}" data-response="always">总是允许</button>
    <button ${disabled} class="reject" data-permission-key="${escapeHtml(key)}" data-instance="${escapeHtml(session.instanceId)}" data-session="${escapeHtml(permission.sessionID)}" data-permission="${escapeHtml(permission.id)}" data-response="reject">拒绝</button>
  </div>${error ? `<div class="permission-error">发送失败：${escapeHtml(error)}</div>` : ""}</div>`;
}

function showToast(message: string, error = false): void {
  state.toast = message;
  state.toastError = error;
  window.clearTimeout(toastTimer);
  render();
  toastTimer = window.setTimeout(() => { state.toast = ""; render(); }, 2600);
}

function playSound(kind: "done" | "error" | "permission"): void {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") void audioContext.resume();
    const now = audioContext.currentTime;
    const sequences = { done: [523.25, 659.25, 783.99], error: [330, 220], permission: [659.25, 659.25] };
    sequences[kind].forEach((frequency, index) => {
      const oscillator = audioContext!.createOscillator();
      const gain = audioContext!.createGain();
      oscillator.type = kind === "error" ? "sawtooth" : "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, now + index * .1);
      gain.gain.exponentialRampToValueAtTime(.075, now + index * .1 + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, now + index * .1 + .09);
      oscillator.connect(gain).connect(audioContext!.destination);
      oscillator.addEventListener("ended", () => { oscillator.disconnect(); gain.disconnect(); }, { once: true });
      oscillator.start(now + index * .1);
      oscillator.stop(now + index * .1 + .1);
    });
  } catch { /* Audio is a bonus; never break the pet if unavailable. */ }
}

async function updateSetting(key: string, value: unknown): Promise<boolean> {
  const previous = state.settings[key];
  applySettings({ [key]: value });
  render();
  try {
    if (!bridge) throw new Error("桌宠服务尚未连接");
    const updated = await bridge.updateSettings({ [key]: value } as SettingsUpdate);
    if (updated && typeof updated === "object") applySettings({ ...updated, shortcutError: updated.shortcutError ?? "" });
    render();
    if (key === "shortcuts" && state.settings.shortcutError) return false;
    return true;
  } catch (error) {
    applySettings({ [key]: previous });
    showToast(error instanceof Error ? error.message : "保存设置失败", true);
    return false;
  }
}

function terminalPermissionError(error: unknown): string {
  const message = error instanceof Error ? error.message : text(error);
  if (message.includes("请回终端处理")) return message;
  return message ? `${message}；请回终端处理` : "请回终端处理";
}

root.addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button, input");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "toggle-panel") { state.panelOpen = !state.panelOpen; state.tab = "tasks"; render(); return; }
  if (action === "close-panel") { state.panelOpen = false; render(); return; }
  if (action === "settings") { state.panelOpen = true; state.tab = "settings"; render(); return; }
  if (action === "minimize" || action === "close") { await bridge?.windowAction(action); return; }
  if (action === "choose-skin") {
    try {
      if (!bridge) throw new Error("桌宠服务尚未连接");
      const result = await bridge.chooseSkin();
      if (result) { applySettings({ skin: result as Exclude<PetSettings["skin"], undefined> }); showToast("皮肤已更新"); }
    } catch (error) { showToast(error instanceof Error ? error.message : "选择皮肤失败", true); }
    return;
  }
  if (action === "pin-task") {
    const key = target.dataset.pinKey!;
    const pinned = new Set(state.settings.pinnedSessions);
    if (pinned.has(key)) pinned.delete(key); else pinned.add(key);
    void updateSetting("pinnedSessions", [...pinned]);
    return;
  }
  if (action === "dnd-toggle") {
    void updateSetting("dndUntil", Number(state.settings.dndUntil) > Date.now() ? 0 : Date.now() + 30 * 60_000);
    return;
  }
  if (action === "save-shortcuts") {
    const shortcuts = settingsView.shortcutValues();
    if (await updateSetting("shortcuts", shortcuts)) {
      settingsView.markShortcutsSaved();
      settingsDirty = true;
      showToast("快捷键已保存");
    }
    return;
  }
  const tab = target.dataset.tab as typeof state.tab | undefined;
  if (tab) { state.tab = tab; render(); return; }

  const response = target.dataset.response as PermissionResponse | undefined;
  if (response) {
    const key = target.dataset.permissionKey!;
    state.replying.add(key);
    permissionInstances.set(key, target.dataset.instance!);
    clearPermissionError(key);
    tasksDirty = true;
    waitForPermissionConfirmation(key);
    render();
    try {
      if (!bridge) throw new Error("桌宠服务尚未连接");
      await bridge.replyPermission(target.dataset.instance!, target.dataset.session!, target.dataset.permission!, response);
      if (state.replying.has(key)) showToast("请求已发送，等待终端确认");
    } catch (error) {
      clearPermissionPending(key);
      setPermissionError(key, terminalPermissionError(error));
      showToast("授权回复失败，请回终端处理", true);
      render();
    }
  }
});

root.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.setting === "scale") {
    state.settings.scale = Number(input.value);
    document.documentElement.style.setProperty("--pet-scale", input.value);
    const label = input.closest("label")?.querySelector("small");
    if (label) label.textContent = `${Math.round(Number(input.value) * 100)}%`;
    scheduleWindowLayout();
    scheduleInteractiveRegions();
  }
});

root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.notifyKind && input.dataset.notifyChannel) {
    const kind = input.dataset.notifyKind as NotificationKind;
    const channel = input.dataset.notifyChannel as "sound" | "popup";
    const notifications = state.settings.notifications!;
    void updateSetting("notifications", { ...notifications, [kind]: { ...notifications[kind], [channel]: input.checked } });
    return;
  }
  const key = input.dataset.setting;
  if (!key) return;
  const value = input.type === "checkbox" ? input.checked : Number(input.value);
  void updateSetting(key, value);
});

function handleSnapshot(snapshot: PetSnapshot): void {
  const next = {
    ...snapshot,
    connections: Array.isArray(snapshot?.connections) ? snapshot.connections : [],
    sessions: Array.isArray(snapshot?.sessions) ? snapshot.sessions : [],
  };
  if (state.replying.size || state.permissionErrors.size) reconcilePendingPermissions(next);
  state.snapshot = next;
  summaryDirty = true;
  tasksDirty = true;
  state.bubble = "";
  if (state.mood !== "celebrate") state.mood = "idle";
  if (snapshot.settings) applySettings(snapshot.settings);
  render();
}

function updateVisibility(): void {
  const visible = isVisible();
  document.body.classList.toggle("is-paused", !visible);
  if (!visible) {
    window.clearTimeout(skinFrameTimer);
    skinFrameTimer = 0;
    window.cancelAnimationFrame(regionReportRequest);
    window.cancelAnimationFrame(layoutReportRequest);
    renderDeferred = true;
    return;
  }
  if (renderDeferred) render();
  else { scheduleWindowLayout(); scheduleInteractiveRegions(); }
}

function handleNotify(payload: unknown): void {
  const envelope = asRecord(payload);
  const event = asRecord(envelope.event ?? payload);
  const outerType = text(envelope.type).toLowerCase();
  if (outerType === "settings.changed") {
    const settings = asRecord(envelope.settings);
    applySettings({ ...settings, shortcutError: text(settings.shortcutError) });
    render();
    return;
  }
  if (outerType === "visibility") {
    state.windowVisible = envelope.visible !== false;
    updateVisibility();
    return;
  }
  if (outerType === "ui-action") {
    state.panelOpen = true;
    state.tab = envelope.action === "open-settings" ? "settings" : "tasks";
    render();
    return;
  }
  if (outerType === "alert") {
    if (envelope.sound === true) {
      const kind = text(envelope.kind);
      playSound(kind === "task_done" ? "done" : kind === "error" ? "error" : "permission");
    }
    return;
  }
  if (outerType === "permission.replied") {
    const key = permissionKey(text(envelope.instanceId), text(envelope.sessionID), text(envelope.permissionID));
    clearPermissionPending(key);
    if (envelope.ok === false) {
      const reason = terminalPermissionError(envelope.error);
      setPermissionError(key, reason);
      showToast(`授权失败：${reason}`, true);
    } else {
      clearPermissionError(key);
      showToast(envelope.response === "reject" ? "拒绝已确认" : "授权已确认");
    }
    return;
  }

  const type = text(event.kind ?? event.type ?? event.name ?? outerType).toLowerCase();
  if (/permission/.test(type) && !/replied/.test(type)
    && state.settings.notifications?.permission.popup !== false && Number(state.settings.dndUntil) <= Date.now()) {
    state.panelOpen = true;
    state.tab = "tasks";
  }
  if (/error|fail/.test(type)) { window.clearTimeout(celebrateTimer); state.mood = "error"; }
  if (/done|complete|finish/.test(type)) {
    state.mood = "celebrate";
    state.bubble = bubbleForMood("celebrate");
    window.clearTimeout(celebrateTimer);
    celebrateTimer = window.setTimeout(() => {
      state.mood = "idle";
      state.bubble = "";
      render();
    }, 2300);
  }
  const message = text(event.message ?? event.title);
  if (message && !/done|complete|finish/.test(type)) state.bubble = message;
  render();
}

async function start(): Promise<void> {
  render();
  if (!bridge) { state.bubble = "等待桌宠服务连接…"; render(); return; }
  bridge.onSnapshot(handleSnapshot);
  bridge.onNotify(handleNotify);
  bridge.onDragState?.(handleDragState);
  try {
    const settings = await bridge.getSettings();
    if (settings) applySettings(settings);
  } catch { showToast("读取设置失败", true); }
  render();
}

window.addEventListener("resize", scheduleInteractiveRegions);
document.addEventListener("visibilitychange", updateVisibility);
const stage = root.querySelector<HTMLElement>(".stage");
if (stage) new ResizeObserver(scheduleWindowLayout).observe(stage);
root.addEventListener("transitionend", (event) => {
  if ((event.target as Element).matches(".stage")) scheduleInteractiveRegions();
});
root.addEventListener("animationend", (event) => {
  if ((event.target as Element).matches(".bubble, .panel")) scheduleInteractiveRegions();
});

void start();
