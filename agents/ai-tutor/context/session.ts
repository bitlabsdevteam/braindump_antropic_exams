import crypto from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getQuestion } from "../../../lib/db";
import { migrateMemory } from "../memory/schema";
import type { TutorMessage } from "../types";

export const retentionMs = 30 * 24 * 60 * 60 * 1000;
const idleMs = 2 * 60 * 60 * 1000;
const conversationMs = 24 * 60 * 60 * 1000;
let db: Database.Database | undefined;

export function sessionDatabase() {
  if (db) return db;
  const file =
    process.env.LEARNING_DB_PATH || path.join(process.cwd(), "data", "tutor-sessions.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // The old session tables remain compatible; learning data uses stable source keys.
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_by_question ON messages(session_id, question_id, id);
    CREATE TABLE IF NOT EXISTS reveals (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, revealed_at INTEGER NOT NULL, PRIMARY KEY(session_id, question_id));
    CREATE TABLE IF NOT EXISTS outcomes (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, question_id INTEGER NOT NULL, certification_slug TEXT NOT NULL, domain_name TEXT, revealed_at INTEGER NOT NULL, PRIMARY KEY(session_id, question_id));
    CREATE TABLE IF NOT EXISTS runs (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','done')), created_at INTEGER NOT NULL, PRIMARY KEY(session_id, request_id));
    CREATE TABLE IF NOT EXISTS learning_migrations (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS question_state (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, source_key TEXT NOT NULL,
      certification_slug TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '[]', reasoning TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      hint_count INTEGER NOT NULL DEFAULT 0, assisted INTEGER NOT NULL DEFAULT 0,
      exposed INTEGER NOT NULL DEFAULT 0, visible INTEGER NOT NULL DEFAULT 0,
      submitted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, source_key));
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, source_key TEXT NOT NULL, certification_slug TEXT NOT NULL,
      domain_name TEXT, selected TEXT NOT NULL, correct INTEGER NOT NULL CHECK(correct IN (0,1)),
      kind TEXT NOT NULL CHECK(kind IN ('independent','assisted','review')), hint_count INTEGER NOT NULL,
      generation INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(session_id, request_id), UNIQUE(session_id, source_key, generation),
      FOREIGN KEY(session_id, source_key) REFERENCES question_state(session_id, source_key) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS attempts_by_learner ON attempts(session_id, certification_slug, created_at);
    CREATE TABLE IF NOT EXISTS practice_settings (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, certification_slug TEXT NOT NULL,
      question_key TEXT, started INTEGER NOT NULL DEFAULT 0, deadline INTEGER,
      PRIMARY KEY(session_id, certification_slug));
    INSERT OR IGNORE INTO learning_migrations(version) VALUES (1);`);
  // Repair orphaned records left by older connections without FK enforcement.
  for (const table of ["messages", "reveals", "outcomes", "runs"]) {
    db.exec(`DELETE FROM ${table} WHERE session_id NOT IN (SELECT id FROM sessions)`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_windows (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, question_id));
    INSERT OR IGNORE INTO conversation_windows
      SELECT session_id, question_id, MIN(created_at), MAX(created_at)
      FROM messages GROUP BY session_id, question_id;
    INSERT OR IGNORE INTO learning_migrations(version) VALUES (2);`);
  migrateMemory(db);
  return db;
}

export function createSessionId() {
  return crypto.randomBytes(24).toString("base64url");
}
export function ensureSession(candidate?: string): string {
  const database = sessionDatabase();
  const now = Date.now();
  database.prepare("DELETE FROM sessions WHERE created_at <= ?").run(now - retentionMs);
  const current = candidate
    ? (database
        .prepare("SELECT id, touched_at as touchedAt FROM sessions WHERE id = ?")
        .get(candidate) as { id: string; touchedAt: number } | undefined)
    : undefined;
  const id = current?.id || createSessionId();
  if (current) {
    if (current.touchedAt <= now - idleMs) clearConversation(id, false);
    database.prepare("UPDATE sessions SET touched_at = ? WHERE id = ?").run(now, id);
  } else database.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(id, now, now);
  // Expiry applies to whole conversations, so old answer-bearing context cannot survive.
  const expired = database
    .prepare(
      "SELECT session_id as id, question_id as questionId FROM conversation_windows WHERE created_at <= ? OR touched_at <= ?",
    )
    .all(now - conversationMs, now - idleMs) as { id: string; questionId: number }[];
  for (const row of expired) {
    database.transaction(() => {
      database
        .prepare("DELETE FROM messages WHERE session_id = ? AND question_id = ?")
        .run(row.id, row.questionId);
      database
        .prepare("DELETE FROM conversation_windows WHERE session_id = ? AND question_id = ?")
        .run(row.id, row.questionId);
      const sourceKey = getQuestion(row.questionId)?.sourceKey;
      if (sourceKey)
        database
          .prepare(
            "UPDATE question_state SET revision = revision + 1 WHERE session_id = ? AND source_key = ?",
          )
          .run(row.id, sourceKey);
    })();
  }
  return id;
}
export function sessionExpires(id: string) {
  const row = sessionDatabase().prepare("SELECT created_at FROM sessions WHERE id = ?").get(id) as
    { created_at: number } | undefined;
  return row ? row.created_at + retentionMs : 0;
}
export function clearConversation(id: string, forgetMemory = true) {
  const database = sessionDatabase();
  database.transaction(() => {
    if (forgetMemory) database.prepare("DELETE FROM tutor_turns WHERE session_id = ?").run(id);
    database.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    database.prepare("DELETE FROM conversation_windows WHERE session_id = ?").run(id);
    database
      .prepare("UPDATE question_state SET revision = revision + 1 WHERE session_id = ?")
      .run(id);
  })();
}
export function history(sessionId: string, questionId: number): TutorMessage[] {
  return sessionDatabase()
    .prepare(
      "SELECT role, content FROM (SELECT role, content, id FROM messages WHERE session_id = ? AND question_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id",
    )
    .all(sessionId, questionId) as TutorMessage[];
}
export function addMessage(sessionId: string, questionId: number, message: TutorMessage) {
  const database = sessionDatabase();
  const now = Date.now();
  database
    .prepare(
      "INSERT INTO conversation_windows VALUES (?, ?, ?, ?) ON CONFLICT(session_id, question_id) DO UPDATE SET touched_at = excluded.touched_at",
    )
    .run(sessionId, questionId, now, now);
  database
    .prepare(
      "INSERT INTO messages(session_id, question_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(sessionId, questionId, message.role, message.content, Date.now());
  database
    .prepare(
      "DELETE FROM messages WHERE session_id = ? AND question_id = ? AND id NOT IN (SELECT id FROM messages WHERE session_id = ? AND question_id = ? ORDER BY id DESC LIMIT 12)",
    )
    .run(sessionId, questionId, sessionId, questionId);
}
export function isRevealed(sessionId: string, questionId: number) {
  const key = getQuestion(questionId)?.sourceKey;
  return Boolean(
    key &&
    (
      sessionDatabase()
        .prepare("SELECT visible FROM question_state WHERE session_id = ? AND source_key = ?")
        .get(sessionId, key) as { visible: number } | undefined
    )?.visible,
  );
}
export function hide(sessionId: string, questionId: number) {
  const key = getQuestion(questionId)?.sourceKey;
  if (!key) return;
  const database = sessionDatabase();
  database.transaction(() => {
    database
      .prepare(
        "UPDATE question_state SET visible = 0, revision = revision + 1 WHERE session_id = ? AND source_key = ?",
      )
      .run(sessionId, key);
    database
      .prepare("DELETE FROM messages WHERE session_id = ? AND question_id = ?")
      .run(sessionId, questionId);
    database
      .prepare("DELETE FROM conversation_windows WHERE session_id = ? AND question_id = ?")
      .run(sessionId, questionId);
    database
      .prepare("DELETE FROM reveals WHERE session_id = ? AND question_id = ?")
      .run(sessionId, questionId);
  })();
}
export function resetSession(sessionId: string) {
  sessionDatabase().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}
export function beginRun(sessionId: string, requestId: string) {
  const database = sessionDatabase();
  const now = Date.now();
  return database
    .transaction(() => {
      database
        .prepare(
          "UPDATE runs SET state = 'done' WHERE session_id = ? AND state = 'active' AND created_at < ?",
        )
        .run(sessionId, now - 70_000);
      database
        .prepare("DELETE FROM runs WHERE state = 'done' AND created_at < ?")
        .run(now - conversationMs);
      if (
        database
          .prepare("SELECT 1 FROM runs WHERE session_id = ? AND state = 'active'")
          .get(sessionId)
      )
        return false;
      try {
        database
          .prepare("INSERT INTO runs VALUES (?, ?, 'active', ?)")
          .run(sessionId, requestId, now);
        return true;
      } catch {
        return false;
      }
    })
    .immediate();
}
export function runActive(sessionId: string, requestId: string) {
  return Boolean(
    sessionDatabase()
      .prepare(
        "SELECT 1 FROM runs JOIN sessions ON sessions.id = runs.session_id WHERE session_id = ? AND request_id = ? AND state = 'active' AND sessions.created_at > ?",
      )
      .get(sessionId, requestId, Date.now() - retentionMs),
  );
}
export function finishRun(sessionId: string, requestId: string) {
  sessionDatabase()
    .prepare("UPDATE runs SET state = 'done' WHERE session_id = ? AND request_id = ?")
    .run(sessionId, requestId);
}
export function runsInLastMinute(sessionId: string) {
  return Number(
    (
      sessionDatabase()
        .prepare("SELECT COUNT(*) as count FROM runs WHERE session_id = ? AND created_at >= ?")
        .get(sessionId, Date.now() - 60_000) as { count: number }
    ).count,
  );
}
