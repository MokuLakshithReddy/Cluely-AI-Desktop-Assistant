import { contextBridge, ipcRenderer } from 'electron';
import { SharedState, Role, DesktopBridge } from '../src/lib/types';

const desktopBridge: DesktopBridge = {
  getSharedState: () => ipcRenderer.invoke('get-shared-state'),
  patchSharedState: (patch: Partial<SharedState>) => ipcRenderer.invoke('patch-shared-state', patch),
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
  startListening: () => ipcRenderer.invoke('patch-shared-state', { isRecording: true }),
  stopListening: () => ipcRenderer.invoke('patch-shared-state', { isRecording: false }),
  toggleStealthMode: (enable: boolean) => ipcRenderer.invoke('toggle-stealth-mode', enable),
  dragControlWindow: (pos: { x: number; y: number }) => ipcRenderer.send('drag-control-window', pos),
  dragControlWindowEnd: () => ipcRenderer.send('drag-control-window-end'),
  resizeChatWindow: (height: number) => ipcRenderer.send('resize-chat-window', height),
  openDashboard: (tab?: string) => ipcRenderer.send('open-dashboard', tab),

  onSharedStateUpdated: (callback: (state: SharedState) => void) => {
    const handler = (_event: any, state: SharedState) => callback(state);
    ipcRenderer.on('shared-state-updated', handler);
    return () => ipcRenderer.off('shared-state-updated', handler);
  },

  onAudioChunk: (callback: (data: { role: Role; chunk: ArrayBuffer }) => void) => {
    const handler = (_event: any, data: { role: Role; chunk: ArrayBuffer }) => callback(data);
    ipcRenderer.on('audio-chunk', handler);
    return () => ipcRenderer.off('audio-chunk', handler);
  },

  onShortcutAction: (callback: (action: string) => void) => {
    const handler = (_event: any, action: string) => callback(action);
    ipcRenderer.on('shortcut-action', handler);
    return () => ipcRenderer.off('shortcut-action', handler);
  },
};

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge);

