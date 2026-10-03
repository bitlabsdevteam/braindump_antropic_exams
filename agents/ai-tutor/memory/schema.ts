import type Database from "better-sqlite3";

// Additive migration: existing practice progress and the legacy short-lived cache survive.
export function migrateMemory(database: Database.Database) {
  database
    .transaction(() => {
      database.exec(`
      CREATE TABLE IF NOT EXISTS tutor_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        answer_revealed INTEGER NOT NULL CHECK(answer_revealed IN (0,1)),
        user_text TEXT NOT NULL CHECK(length(user_text) BETWEEN 1 AND 1000),
        assistant_json TEXT NOT NULL CHECK(json_valid(assistant_json)),
        tools_json TEXT NOT NULL CHECK(json_valid(tools_json)),
        prompt_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, request_id),
        UNIQUE(session_id, id),
        UNIQUE(session_id, source_key, answer_revealed, id)
      );
      CREATE INDEX IF NOT EXISTS idx_tutor_turns_context ON tutor_turns(session_id, source_key, answer_revealed, id);
      CREATE TABLE IF NOT EXISTS tutor_summaries (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL,
        answer_revealed INTEGER NOT NULL CHECK(answer_revealed IN (0,1)),
        through_turn_id INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
        source_digest TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        input_bytes INTEGER NOT NULL,
        output_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, source_key, answer_revealed),
        FOREIGN KEY(session_id, source_key, answer_revealed, through_turn_id) REFERENCES tutor_turns(session_id, source_key, answer_revealed, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tutor_preferences (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        preference_key TEXT NOT NULL CHECK(preference_key IN ('depth','style','language','experience')),
        preference_value TEXT NOT NULL CHECK(
          (preference_key = 'depth' AND preference_value IN ('brief','detailed')) OR
          (preference_key = 'style' AND preference_value IN ('step_by_step','examples','questions')) OR
          (preference_key = 'language' AND preference_value IN ('English','Japanese','Spanish','French','German','Korean','Chinese','Portuguese')) OR
          (preference_key = 'experience' AND preference_value IN ('beginner','intermediate','advanced'))),
        evidence_turn_id INTEGER NOT NULL,
        evidence_text TEXT NOT NULL CHECK(length(evidence_text) BETWEEN 1 AND 1000),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, preference_key),
        FOREIGN KEY(session_id, evidence_turn_id) REFERENCES tutor_turns(session_id, id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO learning_migrations(version) VALUES (3);
    `);
    })
    .immediate();
}

// Rollback is deliberately explicit and is never run by application startup.
export function rollbackMemory(database: Database.Database) {
  database
    .transaction(() => {
      database.exec(`DROP TABLE IF EXISTS tutor_preferences;
      DROP TABLE IF EXISTS tutor_summaries;
      DROP TABLE IF EXISTS tutor_turns;
      DELETE FROM learning_migrations WHERE version = 3;`);
    })
    .immediate();
}
