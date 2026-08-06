const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callama', {
  listModels: () => ipcRenderer.invoke('models:list'),
  pullModel: (name) => ipcRenderer.invoke('models:pull', { name }),
  listAllModels: () => ipcRenderer.invoke('models:listAll'),
  deleteModel: (name) => ipcRenderer.invoke('models:delete', { name }),
  onPullProgress: (callback) =>
    ipcRenderer.on('models:pullProgress', (_event, data) => callback(data)),
  checkOllama: () => ipcRenderer.invoke('ollama:status'),

  listChats: () => ipcRenderer.invoke('chats:list'),
  createChat: (subject) => ipcRenderer.invoke('chats:create', { subject }),
  renameChat: (chatId, title) => ipcRenderer.invoke('chats:rename', { chatId, title }),
  setPinned: (chatId, pinned) => ipcRenderer.invoke('chats:setPinned', { chatId, pinned }),
  deleteChat: (chatId) => ipcRenderer.invoke('chats:delete', { chatId }),

  getHistory: (chatId) => ipcRenderer.invoke('chat:history', { chatId }),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  edit: (payload) => ipcRenderer.invoke('chat:edit', payload),
  regenerate: (payload) => ipcRenderer.invoke('chat:regenerate', payload),
  stop: (chatId) => ipcRenderer.invoke('chat:stop', { chatId }),

  saveMemory: (subject, content, chatId) => ipcRenderer.invoke('memory:save', { subject, content, chatId }),
  listMemories: (subject) => ipcRenderer.invoke('memory:list', { subject }),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', { id }),

  onChunk: (callback) =>
    ipcRenderer.on('chat:chunk', (_event, data) => callback(data)),
  onDone: (callback) =>
    ipcRenderer.on('chat:done', (_event, data) => callback(data)),
});