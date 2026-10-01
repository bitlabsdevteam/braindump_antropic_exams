import crypto from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { TutorMessage } from "../types";

const dbPath = path.join(process.cwd(), "data", "tutor-sessions.db");
const idleMs = 2 * 60 * 60 * 1000;
const maxMs = 24 * 60 * 60 * 1000;
let db: Database.Database | undefined;

function store() {
  if (!db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_question ON messages(session_id, question_id, id);
      CREATE TABLE IF NOT EXISTS reveals (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, revealed_at INTEGER NOT NULL, PRIMARY KEY(session_id, question_id));
      CREATE TABLE IF NOT EXISTS outcomes (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, certification_slug TEXT NOT NULL, domain_name TEXT, revealed_at INTEGER NOT NULL, PRIMARY KEY(session_id, question_id));
      CREATE TABLE IF NOT EXISTS runs (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','done')), created_at INTEGER NOT NULL, PRIMARY KEY(session_id, request_id));`);
  }
  return db;
}

export function createSessionId() { return crypto.randomBytes(24).toString("base64url"); }

export function ensureSession(sessionId: string) {
  const database = store(); const now = Date.now();
  database.prepare("DELETE FROM sessions WHERE touched_at < ? OR created_at < ?").run(now - idleMs, now - maxMs);
  const current = database.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!current) database.prepare("INSERT INTO sessions (id, created_at, touched_at) VALUES (?, ?, ?)").run(sessionId, now, now);
  else database.prepare("UPDATE sessions SET touched_at = ? WHERE id = ?").run(now, sessionId);
}

export function history(sessionId: string, questionId: number): TutorMessage[] {
  return store().prepare("SELECT role, content FROM (SELECT role, content, id FROM messages WHERE session_id = ? AND question_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id").all(sessionId, questionId) as TutorMessage[];
}
export function addMessage(sessionId: string, questionId: number, message: TutorMessage) { store().prepare("INSERT INTO messages (session_id, question_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, questionId, message.role, message.content, Date.now()); }
export function isRevealed(sessionId: string, questionId: number) { return Boolean(store().prepare("SELECT 1 FROM reveals WHERE session_id = ? AND question_id = ?").get(sessionId, questionId)); }
export function reveal(sessionId: string, questionId: number, certificationSlug: string, domainName: string | null) {
  const now = Date.now(); const database = store();
  database.prepare("INSERT OR REPLACE INTO reveals (session_id, question_id, revealed_at) VALUES (?, ?, ?)").run(sessionId, questionId, now);
  database.prepare("INSERT OR REPLACE INTO outcomes (session_id, question_id, certification_slug, domain_name, revealed_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, questionId, certificationSlug, domainName, now);
}
export function hide(sessionId: string, questionId: number) { const database = store(); database.prepare("DELETE FROM reveals WHERE session_id = ? AND question_id = ?").run(sessionId, questionId); database.prepare("DELETE FROM messages WHERE session_id = ? AND question_id = ?").run(sessionId, questionId); }
export function learningContext(sessionId: string) { return store().prepare("SELECT domain_name as domainName, COUNT(*) as revealedCount FROM outcomes WHERE session_id = ? GROUP BY domain_name ORDER BY revealedCount DESC LIMIT 5").all(sessionId) as { domainName: string | null; revealedCount: number }[]; }
export function resetSession(sessionId: string) { store().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId); }
export function beginRun(sessionId: string, requestId: string) {
  const database = store();
  const active = database.prepare("SELECT 1 FROM runs WHERE session_id = ? AND state = 'active'").get(sessionId);
  if (active) return false;
  try { database.prepare("INSERT INTO runs (session_id, request_id, state, created_at) VALUES (?, ?, 'active', ?)").run(sessionId, requestId, Date.now()); return true; }
  catch { return false; }
}
export function finishRun(sessionId: string, requestId: string) { store().prepare("UPDATE runs SET state = 'done' WHERE session_id = ? AND request_id = ?").run(sessionId, requestId); }
export function runsInLastMinute(sessionId: string) { return Number((store().prepare("SELECT COUNT(*) as count FROM runs WHERE session_id = ? AND created_at >= ?").get(sessionId, Date.now() - 60_000) as { count: number }).count); }
