const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { ChatStore, SUBJECTS } = require('./db');

const OLLAMA_URL = 'http://127.0.0.1:11434';

let mainWindow;
let store;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  store = new ChatStore(path.join(app.getPath('userData'), 'callama.db'));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (store) store.close();
  if (process.platform !== 'darwin') app.quit();
});

// List locally installed Ollama models, for the model-picker dropdown.
ipcMain.handle('models:list', async () => {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
});

// Return this subject's own message history (what the UI displays).
// Note: this is deliberately the subject's OWN table only, not the
// cross-read context — the user should only ever see messages that
// actually live in the thread they're looking at.
ipcMain.handle('chat:history', (_event, subject) => {
  if (!SUBJECTS.includes(subject)) throw new Error(`Unknown subject: ${subject}`);
  return store.db.prepare(`SELECT * FROM ${subject} ORDER BY id ASC`).all();
});

// Edit a past user message: truncate everything after it, then
// regenerate the assistant's reply from the edited point forward.
ipcMain.handle('chat:edit', async (event, { subject, id, content, model, temperature }) => {
  store.editMessage(subject, id, content);
  return streamReply(event, subject, model, temperature);
});

// Send a new user message and stream back the assistant's reply.
ipcMain.handle('chat:send', async (event, { subject, content, model, temperature }) => {
  store.addMessage(subject, 'user', content);
  return streamReply(event, subject, model, temperature);
});

// Shared streaming logic: builds context (own table + linked subjects
// per the access matrix in db.js), calls Ollama with stream:true, and
// forwards each chunk to the renderer over 'chat:chunk' as it arrives.
async function streamReply(event, subject, model, temperature) {
  const context = store.getContext(subject);
  const messages = context.map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3.2:3b',
      messages,
      stream: true,
      options: { temperature: temperature ?? 0.7 },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep the last, possibly-incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);
      if (chunk.message?.content) {
        full += chunk.message.content;
        event.sender.send('chat:chunk', { subject, delta: chunk.message.content });
      }
    }
  }

  const saved = store.addMessage(subject, 'assistant', full);
  event.sender.send('chat:done', { subject, message: saved });
  return saved;
}