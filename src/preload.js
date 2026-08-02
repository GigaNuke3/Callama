const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callama', {
  listModels: () => ipcRenderer.invoke('models:list'),
  getHistory: (subject) => ipcRenderer.invoke('chat:history', subject),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  edit: (payload) => ipcRenderer.invoke('chat:edit', payload),
  onChunk: (callback) =>
    ipcRenderer.on('chat:chunk', (_event, data) => callback(data)),
  onDone: (callback) =>
    ipcRenderer.on('chat:done', (_event, data) => callback(data)),
});