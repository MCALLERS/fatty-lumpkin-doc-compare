'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('lumpkin', {
  getState: () => ipcRenderer.invoke('app:state'),
  pendingFiles: () => ipcRenderer.invoke('files:pending'),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  describeFiles: (paths) => ipcRenderer.invoke('files:describe', paths),
  guessOlder: (pair) => ipcRenderer.invoke('files:guessOlder', pair),
  compare: (payload) => ipcRenderer.invoke('compare:run', payload),
  cancelCompare: (token) => ipcRenderer.invoke('compare:cancel', token),
  contextMenuStatus: () => ipcRenderer.invoke('contextMenu:status'),
  openFile: (p) => ipcRenderer.invoke('file:open', p),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  installContextMenu: () => ipcRenderer.invoke('contextMenu:install'),
  uninstallContextMenu: () => ipcRenderer.invoke('contextMenu:uninstall'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  onFiles: on('files:received'),
  onProgress: on('compare:progress'),
  onMenuChoose: on('menu:choose'),
  onMenuSettings: on('menu:settings'),
});
