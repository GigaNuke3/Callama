const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { ChatStore, SUBJECTS } = require('./db');

const OLLAMA_URL = 'http://127.0.0.1:11434';

// Soft steering, not hard refusal: each subject gets a system prompt
// that nudges the model toward its focus without blocking off-topic
// questions. The model can still answer anything — it's just told to
// name the mismatch and point toward a better-suited subject when one
// exists, rather than refusing outright.
const SUBJECT_PROMPTS = {
  predictability:
    "You're in the Predictability chat — everyday, general conversation. There's no strict focus here; answer naturally.",
  health:
    "You're in the Health chat — physical and mental health questions (medicine, exercise, neurological topics). " +
    "If the user asks something unrelated to health or wellbeing, you can still answer briefly, but gently note it's outside " +
    "this chat's focus and that a different subject chat (like Predictability) might serve them better going forward.",
  wellbeing:
    "You're in the WellBeing chat — mental health, philosophy, and self-focus, distinct from clinical Health topics. " +
    "If the user asks something unrelated, you can still answer briefly, but gently note it's outside this chat's focus " +
    "and that a different subject chat (like Predictability) might serve them better going forward.",
  education:
    "You're in the Education chat — creative writing and general knowledge/information. " +
    "If the user asks something unrelated, you can still answer briefly, but gently note it's outside this chat's focus " +
    "and that a different subject chat (like Predictability) might serve them better going forward.",
  logicalthinking:
    "You're in the LogicalThinking chat — code, math, and engineering, analytical and rational reasoning. " +
    "If the user asks something unrelated (e.g. casual or personal questions), you can still answer briefly, but gently note " +
    "it's outside this chat's focus and that a different subject chat (like Predictability) might serve them better going forward.",
};

let mainWindow;
let store;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 660,
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

// --- Chat CRUD ---------------------------------------------------------

ipcMain.handle('chats:list', () => store.listChats());

ipcMain.handle('chats:create', (_event, { subject }) => {
  if (!SUBJECTS.includes(subject)) throw new Error(`Unknown subject: ${subject}`);
  return store.createChat(subject);
});

ipcMain.handle('chats:rename', (_event, { chatId, title }) => store.renameChat(chatId, title));

ipcMain.handle('chats:delete', (_event, { chatId }) => {
  store.deleteChat(chatId);
  return { chatId };
});

ipcMain.handle('chat:history', (_event, { chatId }) => store.getHistory(chatId));

// Edit a past user message: truncate everything after it, then
// regenerate the assistant's reply from the edited point forward.
ipcMain.handle('chat:edit', async (event, { chatId, id, content, model, temperature }) => {
  store.editMessage(chatId, id, content);
  return streamReply(event, chatId, model, temperature);
});

// Send a new user message and stream back the assistant's reply.
ipcMain.handle('chat:send', async (event, { chatId, content, model, temperature }) => {
  store.addMessage(chatId, 'user', content);
  return streamReply(event, chatId, model, temperature);
});

// Shared streaming logic: builds context (own chat + linked subjects
// per the access matrix in db.js), calls Ollama with stream:true, and
// forwards each chunk to the renderer over 'chat:chunk' as it arrives.
async function streamReply(event, chatId, model, temperature) {
  const chat = store.getChat(chatId);
  const context = store.getContext(chatId);
  const messages = [
    { role: 'system', content: SUBJECT_PROMPTS[chat.subject] },
    ...context.map((m) => ({ role: m.role, content: m.content })),
  ];

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
        event.sender.send('chat:chunk', { chatId, delta: chunk.message.content });
      }
    }
  }

  const saved = store.addMessage(chatId, 'assistant', full);
  event.sender.send('chat:done', { chatId, message: saved });
  return saved;
}