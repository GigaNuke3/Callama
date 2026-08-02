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

  for (const subject of SUBJECTS) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${subject} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        edited_at TEXT
      );
    `);
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

  // Insert a new message into a subject table. Returns the new row.
  addMessage(subject, role, content) {
    this._assertSubject(subject);
    const stmt = this.db.prepare(
      `INSERT INTO ${subject} (role, content) VALUES (?, ?)`
    );
    const info = stmt.run(role, content);
    return this.db
      .prepare(`SELECT * FROM ${subject} WHERE id = ?`)
      .get(info.lastInsertRowid);
  }

  // Edit an existing user message, discarding everything that came
  // after it in the SAME table (its old reply + any later turns).
  // The new AI response is generated fresh by the caller afterward.
  editMessage(subject, id, newContent) {
    this._assertSubject(subject);
    const del = this.db.prepare(`DELETE FROM ${subject} WHERE id > ?`);
    const upd = this.db.prepare(
      `UPDATE ${subject} SET content = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    );
    const tx = this.db.transaction((subj, msgId, text) => {
      del.run(msgId);
      upd.run(text, msgId);
    });
    tx(subject, id, newContent);
    return this.db.prepare(`SELECT * FROM ${subject} WHERE id = ?`).get(id);
  }

  // Build the context to send to Ollama: this subject's own history,
  // plus (if allowed) the linked subjects' history, merged in time order.
  getContext(subject, { limit = 40 } = {}) {
    this._assertSubject(subject);
    const readable = [subject, ...(CAN_READ[subject] || [])];

    const rows = readable.flatMap((subj) =>
      this.db
        .prepare(`SELECT id, role, content, created_at, '${subj}' as source FROM ${subj}`)
        .all()
    );

    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return rows.slice(-limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = { ChatStore, SUBJECTS, CAN_READ };