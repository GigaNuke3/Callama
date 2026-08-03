const path = require('path');
const Database = require('better-sqlite3');

// The five subjects. "predictability" is a table like any other —
// its only special property is a wider can_read list below.
const SUBJECTS = ['predictability', 'health', 'education', 'wellbeing', 'logicalthinking'];

// Access matrix: which OTHER tables each subject may read from,
// in addition to its own. This is the only place the cross-table
// rules live — nothing else in the app needs to know about them.
const CAN_READ = {
  predictability: ['health', 'education', 'wellbeing', 'logicalthinking'],
  health: ['wellbeing'],
  wellbeing: ['health'],
  education: ['logicalthinking'],
  logicalthinking: ['education'],
};

function openDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Chats are the actual conversations the user sees in the sidebar.
  // A chat's subject is fixed at creation and never changes — see
  // the note in ChatStore.createChat for why.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL CHECK (subject IN ('predictability','health','education','wellbeing','logicalthinking')),
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  // Each subject table now scopes its rows to a specific chat via
  // chat_id. ON DELETE CASCADE means deleting a chat row automatically
  // removes its messages from whichever subject table they live in.
  for (const subject of SUBJECTS) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${subject} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        edited_at TEXT
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${subject}_chat_id ON ${subject}(chat_id);`);
  }

  return db;
}

class ChatStore {
  constructor(dbPath) {
    this.db = openDatabase(dbPath || path.join(__dirname, '..', 'callama.db'));
  }

  _assertSubject(subject) {
    if (!SUBJECTS.includes(subject)) {
      throw new Error(`Unknown subject: ${subject}`);
    }
  }

  _getChat(chatId) {
    const chat = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    return chat;
  }

  // Public accessor — same lookup, for callers outside this class
  // (e.g. main.js needs the chat's subject to pick a system prompt).
  getChat(chatId) {
    return this._getChat(chatId);
  }

  // --- Chat CRUD -----------------------------------------------------

  // Subject is chosen once, here, and never changes afterward. If it
  // could change later, a chat's earlier messages (already written into
  // the OLD subject's table) would become unreachable — there'd be no
  // way to find them again since lookups are always subject-scoped.
  createChat(subject = 'predictability', title = 'New chat') {
    this._assertSubject(subject);
    const info = this.db
      .prepare('INSERT INTO chats (subject, title) VALUES (?, ?)')
      .run(subject, title);
    return this._getChat(info.lastInsertRowid);
  }

  listChats() {
    return this.db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
  }

  renameChat(chatId, title) {
    this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, chatId);
    return this._getChat(chatId);
  }

  deleteChat(chatId) {
    // Cascades into whichever subject table holds this chat's messages.
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  }

  touchChat(chatId) {
    this.db
      .prepare(`UPDATE chats SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(chatId);
  }

  // --- Messages --------------------------------------------------------

  // Insert a new message into a chat's subject table.
  addMessage(chatId, role, content) {
    const chat = this._getChat(chatId);
    const stmt = this.db.prepare(
      `INSERT INTO ${chat.subject} (chat_id, role, content) VALUES (?, ?, ?)`
    );
    const info = stmt.run(chatId, role, content);
    this.touchChat(chatId);
    return this.db
      .prepare(`SELECT * FROM ${chat.subject} WHERE id = ?`)
      .get(info.lastInsertRowid);
  }

  // This chat's own message history — what the UI displays.
  getHistory(chatId) {
    const chat = this._getChat(chatId);
    return this.db
      .prepare(`SELECT * FROM ${chat.subject} WHERE chat_id = ? ORDER BY id ASC`)
      .all(chatId);
  }

  // Edit an existing user message, discarding everything that came
  // after it in the SAME chat (its old reply + any later turns).
  editMessage(chatId, id, newContent) {
    const chat = this._getChat(chatId);
    const del = this.db.prepare(`DELETE FROM ${chat.subject} WHERE chat_id = ? AND id > ?`);
    const upd = this.db.prepare(
      `UPDATE ${chat.subject} SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    );
    const tx = this.db.transaction((cId, msgId, text) => {
      del.run(cId, msgId);
      upd.run(text, msgId);
    });
    tx(chatId, id, newContent);
    return this.db.prepare(`SELECT * FROM ${chat.subject} WHERE id = ?`).get(id);
  }

  // Delete a message and everything after it in the same chat. Used to
  // regenerate an assistant reply: the caller deletes from that reply's
  // id onward (removing the stale answer, and any later turns if this
  // wasn't actually the last message), then re-streams a fresh one —
  // the preceding user message stays untouched, so it's re-used as-is.
  deleteFrom(chatId, id) {
    const chat = this._getChat(chatId);
    this.db.prepare(`DELETE FROM ${chat.subject} WHERE chat_id = ? AND id >= ?`).run(chatId, id);
  }

  // Build the context to send to Ollama for a given chat:
  // - EVERYTHING in the chat's subject table, across ALL chats of that
  //   subject — not just this one chat_id. Chats are organizational
  //   folders/titles for browsing a subject's conversation history in
  //   the sidebar; they are NOT isolated memory silos. A subject
  //   remembers everything said to it, regardless of which chat window
  //   you're currently looking at.
  // - plus, if the subject allows it, the most recent messages from
  //   linked subjects, blended across ALL their chats too — since a
  //   linked subject is a whole domain of context, not a single
  //   conversation. (This was already how linked reads worked — the
  //   bug was that OWN reads didn't follow the same rule, which made a
  //   linked subject "remember" things a chat's own subject forgot.)
  getContext(chatId, { limit = 40 } = {}) {
    const chat = this._getChat(chatId);
    const own = this.db
      .prepare(`SELECT id, role, content, created_at, '${chat.subject}' as source FROM ${chat.subject}`)
      .all();

    const linkedSubjects = CAN_READ[chat.subject] || [];
    const linked = linkedSubjects.flatMap((subj) =>
      this.db
        .prepare(`SELECT id, role, content, created_at, '${subj}' as source FROM ${subj}`)
        .all()
    );

    const rows = [...own, ...linked];
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return rows.slice(-limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = { ChatStore, SUBJECTS, CAN_READ };