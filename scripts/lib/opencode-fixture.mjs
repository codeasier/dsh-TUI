/** Synthetic-only OpenCode SQLite fixtures; importing this module creates no files.
 * Relevant columns/indexes from anomalyco/opencode
 * aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/core/src/session/sql.ts.
 */
import { DatabaseSync } from 'node:sqlite'

export function createOpenCodeDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, revert TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE INDEX session_parent_idx ON session(parent_id);
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id),
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id),
      session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX part_message_id_id_idx ON part(message_id, id);
    CREATE INDEX part_session_idx ON part(session_id);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
    CREATE TABLE session_input (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), prompt TEXT NOT NULL,
      delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL, promoted_seq INTEGER, time_created INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX session_input_session_admitted_seq_idx ON session_input(session_id, admitted_seq);
  `)
  return db
}

export function insertOpenCodeExport(db, { info, messages }) {
  db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, revert, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    info.id, info.projectID ?? 'project_fixture', info.parentID ?? null, info.slug ?? 'fixture',
    info.directory ?? '', info.title ?? '', info.version ?? '1.18.34',
    info.revert ? JSON.stringify(info.revert) : null, info.time.created, info.time.updated ?? info.time.created,
  )
  const messageInsert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
  const partInsert = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
  for (const message of messages) {
    const { id, sessionID: _sessionID, ...data } = message.info
    const time = message.info.time?.created ?? info.time.created
    messageInsert.run(id, info.id, time, time, JSON.stringify(data))
    for (const part of message.parts) {
      const { id: partID, sessionID: _session, messageID: _message, ...partData } = part
      partInsert.run(partID, id, info.id, time, time, JSON.stringify(partData))
    }
  }
}

export function createOpenCodeExport(id = 'ses_fixture', options = {}) {
  const created = options.created ?? 1_700_000_000_000
  const userID = `${id}_message_1`
  const assistantID = `${id}_message_2`
  return {
    info: {
      id, directory: '/synthetic/opencode', title: options.title ?? 'Synthetic OpenCode session',
      time: { created, updated: options.updated ?? created + 100 },
      ...(options.parentID ? { parentID: options.parentID } : {}),
    },
    messages: [
      { info: { id: userID, sessionID: id, role: 'user', time: { created } },
        parts: [{ id: `${id}_part_1`, sessionID: id, messageID: userID, type: 'text', text: 'Synthetic question' }] },
      { info: { id: assistantID, sessionID: id, parentID: userID, role: 'assistant', modelID: 'synthetic-model',
        providerID: 'synthetic', time: { created: created + 1, completed: created + 2 } },
        parts: [{ id: `${id}_part_2`, sessionID: id, messageID: assistantID, type: 'text', text: 'Synthetic answer' }] },
    ],
  }
}
