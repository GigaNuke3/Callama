const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callama', {
  listModels: () => ipcRenderer.invoke('models:list'),
  checkOllama: () => ipcRenderer.invoke('ollama:status'),

  listChats: () => ipcRenderer.invoke('chats:list'),
  createChat: (subject) => ipcRenderer.invoke('chats:create', { subject }),
  renameChat: (chatId, title) => ipcRenderer.invoke('chats:rename', { chatId, title }),
  deleteChat: (chatId) => ipcRenderer.invoke('chats:delete', { chatId }),

  getHistory: (chatId) => ipcRenderer.invoke('chat:history', { chatId }),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  edit: (payload) => ipcRenderer.invoke('chat:edit', payload),
  stop: (chatId) => ipcRenderer.invoke('chat:stop', { chatId }),

  onChunk: (callback) =>
    ipcRenderer.on('chat:chunk', (_event, data) => callback(data)),
  onDone: (callback) =>
    ipcRenderer.on('chat:done', (_event, data) => callback(data)),
});