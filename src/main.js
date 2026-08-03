const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { ChatStore, SUBJECTS } = require('./db');

const OLLAMA_URL = 'http://127.0.0.1:11434';

// Only set if WE spawned the Ollama process ourselves — if the user
// already had `ollama serve` running (manually, or as a system service),
// this stays null and we never touch that process, including on quit.
let ollamaProcess = null;

async function isOllamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Called once at startup. If Ollama's already up, do nothing. Otherwise
// try to spawn `ollama serve` ourselves and wait (with a short retry
// loop, since it takes a moment to bind its port) for it to come online.
// Either way, this never blocks the app window from opening — Callama
// still launches even if Ollama can't be reached, just with the
// connection indicator showing disconnected.
async function ensureOllamaRunning() {
  if (await isOllamaReachable()) return true;

  try {
    ollamaProcess = spawn('ollama', ['serve'], { stdio: 'ignore' });
    ollamaProcess.on('error', (err) => {
      console.error('Could not start "ollama serve" — is Ollama installed and on PATH?', err.message);
      ollamaProcess = null;
    });
  } catch (err) {
    console.error('Failed to spawn ollama serve:', err.message);
    return false;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isOllamaReachable()) return true;
  }
  return false;
}

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

app.whenReady().then(async () => {
  store = new ChatStore(path.join(app.getPath('userData'), 'callama.db'));
  createWindow();
  await ensureOllamaRunning(); // window is already open by the time this resolves

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (store) store.close();
  if (ollamaProcess) ollamaProcess.kill(); // only kills the process WE spawned
  if (process.platform !== 'darwin') app.quit();
});

// Lets the renderer show a live connection indicator, and re-check
// on demand (e.g. a retry button) without restarting the app.
ipcMain.handle('ollama:status', async () => ({ connected: await isOllamaReachable() }));

// The model used to turn text into a vector for memory search. Needs to
// be pulled separately (`ollama pull nomic-embed-text`) — small and CPU-
// friendly. Every embed() call is wrapped so a missing/failed embedding
// model degrades memory features silently rather than breaking chat.
const EMBED_MODEL = 'nomic-embed-text';

async function embed(text) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.embedding || null;
  } catch {
    return null;
  }
}

// List locally installed Ollama models, for the model-picker dropdown.
ipcMain.handle('models:list', async () => {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  const data = await res.json();
  // Exclude embedding-only models (e.g. nomic-embed-text) — they have no
  // chat/generation capability and would break responses if selected.
  // EMBED_MODEL itself is always excluded; the "embed" substring check
  // catches other common embedding model families too (mxbai-embed-*, etc.)
  return (data.models || [])
    .map((m) => m.name)
    .filter((name) => name !== EMBED_MODEL && !name.toLowerCase().includes('embed'));
});

// --- Memory (manual v1) -------------------------------------------------

ipcMain.handle('memory:save', async (_event, { subject, content, chatId }) => {
  const embedding = await embed(content);
  if (!embedding) return { saved: false, reason: 'embedding-unavailable' };

  // Duplicate guard: if something near-identical is already remembered
  // for THIS EXACT subject, skip the save rather than piling up copies.
  // (Deliberately not using searchMemories here — that's scoped to the
  // access matrix, which would wrongly block saving to Health just
  // because a similar memory exists in linked WellBeing.)
  const existing = store.findSimilarInSubject(subject, embedding);
  if (existing) return { saved: false, reason: 'duplicate', existing };

  const memory = store.saveMemory(subject, content, embedding, chatId ?? null);
  return { saved: true, memory };
});

ipcMain.handle('memory:list', (_event, { subject } = {}) => store.listMemories(subject));

ipcMain.handle('memory:delete', (_event, { id }) => {
  store.deleteMemory(id);
  return { id };
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

// Regenerate an assistant reply: delete it (and anything after it) and
// stream a fresh answer using the same preceding user message.
ipcMain.handle('chat:regenerate', async (event, { chatId, id, model, temperature }) => {
  store.deleteFrom(chatId, id);
  return streamReply(event, chatId, model, temperature);
});

// Tracks the in-flight AbortController for each chat that's currently
// streaming a response, so a stop request can cancel the right one.
const activeStreams = new Map();

ipcMain.handle('chat:stop', (_event, { chatId }) => {
  const controller = activeStreams.get(chatId);
  if (controller) controller.abort();
  return { stopped: !!controller };
});

// Send a new user message and stream back the assistant's reply.
ipcMain.handle('chat:send', async (event, { chatId, content, model, temperature }) => {
  store.addMessage(chatId, 'user', content);
  return streamReply(event, chatId, model, temperature);
});

// Shared streaming logic: builds context (own chat + linked subjects
// per the access matrix in db.js), calls Ollama with stream:true, and
// forwards each chunk to the renderer over 'chat:chunk' as it arrives.
// If the request is aborted mid-stream (via chat:stop), whatever was
// generated so far is still saved — a partial answer is more useful
// than losing the response entirely.
async function streamReply(event, chatId, model, temperature) {
  const chat = store.getChat(chatId);
  const context = store.getContext(chatId);

  const messages = [{ role: 'system', content: SUBJECT_PROMPTS[chat.subject] }];

  // Memory retrieval: embed the most recent message (the thing that
  // triggered this reply) and pull in whatever's actually relevant from
  // this subject's memory store, regardless of how long ago it was
  // saved or whether it's still within the recent-messages window.
  const latest = context[context.length - 1];
  if (latest) {
    const queryEmbedding = await embed(latest.content);
    if (queryEmbedding) {
      const memories = store.searchMemories(chat.subject, queryEmbedding);
      if (memories.length > 0) {
        messages.push({
          role: 'system',
          content: 'Relevant memory from past conversations (may or may not be relevant — use your judgment):\n' +
            memories.map((m) => `- ${m.content}`).join('\n'),
        });
      }
    }
  }

  messages.push(...context.map((m) => ({ role: m.role, content: m.content })));

  const controller = new AbortController();
  activeStreams.set(chatId, controller);

  let full = '';
  let stopped = false;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3.2:3b',
        messages,
        stream: true,
        options: { temperature: temperature ?? 0.7 },
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
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
  } catch (err) {
    if (err.name === 'AbortError') {
      stopped = true;
    } else {
      throw err;
    }
  } finally {
    activeStreams.delete(chatId);
  }

  // Nothing generated yet (stopped instantly) — don't save an empty message.
  if (!full.trim()) {
    event.sender.send('chat:done', { chatId, message: null, stopped });
    return null;
  }

  const saved = store.addMessage(chatId, 'assistant', full);
  event.sender.send('chat:done', { chatId, message: saved, stopped });
  return saved;
}