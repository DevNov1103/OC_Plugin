import type { AppDiagnostics, NotificationPreferences, ShortcutPreferences, TaskPreferences } from "../shared/ipc";

export {};

declare global {
type PermissionResponse = "once" | "always" | "reject";

interface PetConnection {
  id: string;
  directory: string;
  connected: boolean;
}

interface PetSessionState {
  instanceId: string;
  instanceLabel: string;
  id?: string;
  sessionID?: string;
  title?: string;
  state?: string;
  status?: string;
  updatedAt?: number | string;
  currentTool?: string;
  activity?: { tool?: string; detail?: string; [key: string]: unknown };
  error?: unknown;
  todo?: unknown;
  todos?: { total: number; completed: number; current?: unknown; [key: string]: unknown } | unknown[];
  permission?: unknown;
  permissions?: unknown[];
  [key: string]: unknown;
}

interface SkinPackage {
  spritesheetDataUrl: string;
  name?: string;
  manifest?: {
    name?: string;
    spritesheet?: string;
    frameWidth?: number;
    frameHeight?: number;
    animations?: Record<string, { row?: number; frames?: number; fps?: number }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface PetSnapshot {
  connections: PetConnection[];
  sessions: PetSessionState[];
  settings?: PetSettings;
  skin?: unknown;
  [key: string]: unknown;
}

interface PetSettings {
  scale?: number;
  autostart?: boolean;
  autoLaunch?: boolean;
  clickThrough?: boolean;
  locked?: boolean;
  inertia?: boolean;
  lowPower?: boolean;
  pinnedSessions?: string[];
  taskPreferences?: TaskPreferences;
  notifications?: NotificationPreferences;
  dndUntil?: number;
  mergeNotifications?: boolean;
  shortcuts?: ShortcutPreferences;
  shortcutError?: string;
  skin?: SkinPackage | string | null;
  customSkin?: unknown;
  [key: string]: unknown;
}

interface PetBridge {
  onSnapshot(callback: (snapshot: PetSnapshot) => void): (() => void) | void;
  onNotify(callback: (event: unknown) => void): (() => void) | void;
  replyPermission(
    instanceId: string,
    sessionID: string,
    permissionID: string,
  response: PermissionResponse,
  ): Promise<unknown> | unknown;
  setClickThrough(value: boolean): Promise<unknown> | unknown;
  setInteractiveRegions?(regions: Array<{ x: number; y: number; width: number; height: number }>): Promise<void> | void;
  setWindowLayout?(layout: { panelOpen: boolean; stageWidth: number; stageHeight: number }): Promise<void> | void;
  getSettings(): Promise<PetSettings> | PetSettings;
  getDiagnostics?(): Promise<AppDiagnostics> | AppDiagnostics;
  updateSettings(partial: Partial<PetSettings>): Promise<PetSettings | void> | PetSettings | void;
  chooseSkin(): Promise<unknown> | unknown;
  windowAction(action: "minimize" | "close" | "quit" | string): Promise<unknown> | unknown;
  dragStart(gesture: { screenX: number; screenY: number; timestamp: number }): Promise<void> | void;
  dragEnd(gesture: { screenX: number; screenY: number; timestamp: number }): Promise<void> | void;
  onDragState?(callback: (state: { phase: "picked" | "dragging" | "gliding" | "dropping" | "settled"; vx: number; vy: number }) => void): (() => void) | void;
}

  interface Window {
    pet?: PetBridge;
    opencodePet?: PetBridge;
  }
}
