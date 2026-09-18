const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghost', {
  transcribe: (pcm, options) => ipcRenderer.invoke('transcribe', pcm, options),
  askText: (text) => ipcRenderer.invoke('ask-text', text),
  refineAnswer: (mode) => ipcRenderer.invoke('refine-answer', mode),
  mockToggle: (topic) => ipcRenderer.invoke('mock-toggle', topic),
  stop: () => ipcRenderer.invoke('stop-answer'),
  ttsSpeak: (text) => ipcRenderer.invoke('tts-speak', text),
  copy: (text) => ipcRenderer.invoke('copy-text', text),
  getConfig: () => ipcRenderer.invoke('get-config'),
  tgAuthStart: () => ipcRenderer.invoke('tg-auth-start'),
  tgAuthPoll: (sid) => ipcRenderer.invoke('tg-auth-poll', sid),
  tgAuthMe: () => ipcRenderer.invoke('tg-auth-me'),
  tgUnlink: () => ipcRenderer.invoke('tg-unlink'),
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
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: (url, digest) => ipcRenderer.invoke('update-download', url, digest),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  quit: () => ipcRenderer.invoke('quit'),
  on: (channel, callback) => {
    ipcRenderer.on(channel, (event, ...args) => callback(...args));
  }
});