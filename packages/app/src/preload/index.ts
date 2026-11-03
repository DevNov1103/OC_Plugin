import { contextBridge, ipcRenderer } from "electron"
import type { PermissionResponse } from "@opencode-pet/protocol"
import {
  IPC_CHANNELS,
  type AppEvent,
  type AppSnapshot,
  type DragGesture,
  type DragState,
  type InteractiveRegion,
  type OpencodePetApi,
  type PetWindowLayout,
  type SettingsUpdate,
  type WindowAction,
} from "../shared/ipc"

const api: OpencodePetApi = {
  onSnapshot(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => callback(snapshot)
    ipcRenderer.on(IPC_CHANNELS.snapshot, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.snapshot, listener)
  },

  onNotify(callback) {
    const listener = (_event: Electron.IpcRendererEvent, event: AppEvent): void => callback(event)
    ipcRenderer.on(IPC_CHANNELS.notify, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.notify, listener)
  },

  replyPermission(
    instanceId: string,
    sessionID: string,
    permissionID: string,
    response: PermissionResponse,
  ) {
    return ipcRenderer.invoke(
      IPC_CHANNELS.replyPermission,
      instanceId,
      sessionID,
      permissionID,
      response,
    ) as Promise<void>
  },

  setClickThrough(value: boolean) {
    return ipcRenderer.invoke(IPC_CHANNELS.setClickThrough, value) as Promise<void>
  },

  setInteractiveRegions(regions: InteractiveRegion[]) {
    return ipcRenderer.invoke(IPC_CHANNELS.setInteractiveRegions, regions) as Promise<void>
  },

  setWindowLayout(layout: PetWindowLayout) {
    return ipcRenderer.invoke(IPC_CHANNELS.setWindowLayout, layout) as Promise<void>
  },

  getSettings() {
    return ipcRenderer.invoke(IPC_CHANNELS.getSettings)
  },

  getDiagnostics() {
    return ipcRenderer.invoke(IPC_CHANNELS.getDiagnostics)
  },

  updateSettings(update: SettingsUpdate) {
    return ipcRenderer.invoke(IPC_CHANNELS.updateSettings, update)
  },

  chooseSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.chooseSkin)
  },

  windowAction(action: WindowAction) {
    return ipcRenderer.invoke(IPC_CHANNELS.windowAction, action) as Promise<void>
  },

  dragStart(gesture: DragGesture) {
    return ipcRenderer.invoke(IPC_CHANNELS.dragStart, gesture) as Promise<void>
  },

  dragEnd(gesture: DragGesture) {
    return ipcRenderer.invoke(IPC_CHANNELS.dragEnd, gesture) as Promise<void>
  },

  onDragState(callback: (state: DragState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: DragState): void => callback(state)
    ipcRenderer.on(IPC_CHANNELS.dragState, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.dragState, listener)
  },
}

contextBridge.exposeInMainWorld("opencodePet", Object.freeze(api))
