// packages/gui/electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

type BchctlChunk = { opId: string; stream: 'stdout' | 'stderr'; chunk: string };

contextBridge.exposeInMainWorld('bchStealth', {
  appInfo: () => ipcRenderer.invoke('appInfo'),
  openPath: (absPath: string) => ipcRenderer.invoke('openPath', absPath),

  getConfig: () => ipcRenderer.invoke('getConfig'),
  setCurrentProfile: (profile: string) => ipcRenderer.invoke('setCurrentProfile', { profile }),
  listProfiles: () => ipcRenderer.invoke('listProfiles'),
  createProfile: (name: string) => ipcRenderer.invoke('createProfile', { name }),
  renameProfile: (oldName: string, newName: string) => ipcRenderer.invoke('renameProfile', { oldName, newName }),

  runBchctl: (args: { profile: string; argv: string[]; env?: Record<string, string> }) =>
    ipcRenderer.invoke('runBchctl', args),
  getBchctlResult: (args: { opId: string }) => ipcRenderer.invoke('getBchctlResult', args),
  killBchctl: (args: { opId: string }) => ipcRenderer.invoke('killBchctl', args),

  onBchctlChunk: (cb: (m: BchctlChunk) => void) => {
    const handler = (_evt: any, payload: BchctlChunk) => cb(payload);
    ipcRenderer.on('bchctl:chunk', handler);
    return () => ipcRenderer.off('bchctl:chunk', handler);
  },

  onBchctlExit: (cb: (m: { opId: string; code: number }) => void) => {
    const handler = (_evt: any, payload: { opId: string; code: number }) => cb(payload);
    ipcRenderer.on('bchctl:exit', handler);
    return () => ipcRenderer.off('bchctl:exit', handler);
  },
});