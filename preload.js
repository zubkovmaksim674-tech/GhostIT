const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghost', {
  transcribe: (pcm) => ipcRenderer.invoke('transcribe', pcm),
  askText: (text) => ipcRenderer.invoke('ask-text', text),
  stop: () => ipcRenderer.invoke('stop-answer'),
  copy: (text) => ipcRenderer.invoke('copy-text', text),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (patch) => ipcRenderer.invoke('save-config', patch),
  hide: () => ipcRenderer.invoke('hide-overlay'),
  show: () => ipcRenderer.invoke('show-overlay'),
  setClickThrough: (value) => ipcRenderer.invoke('set-click-through', value),
  hotkeyMode: () => ipcRenderer.invoke('hotkey-mode'),
  toggleRecording: () => ipcRenderer.invoke('toggle-recording'),
  toggleAuto: () => ipcRenderer.invoke('toggle-auto'),
  downloadModel: () => ipcRenderer.invoke('download-model'),
  getHistory: () => ipcRenderer.invoke('get-history'),
  getHistoryItems: () => ipcRenderer.invoke('get-history-items'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  exportHistory: () => ipcRenderer.invoke('export-history'),
  quit: () => ipcRenderer.invoke('quit'),
  on: (channel, callback) => {
    ipcRenderer.on(channel, (event, ...args) => callback(...args));
  }
});