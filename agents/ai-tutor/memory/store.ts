import { sessionDatabase, sessionExpires, isRevealed } from "../context/session";
import { questionContext, PracticeError } from "../../../lib/practice";
import {
  preferenceValues,
  type MemorySummary,
  type MemoryUpdate,
  type PreferenceKey,
  type MemoryView,
} from "../../../lib/tutor-memory-types";
import type { TutorReply } from "../types";

export type StoredTurn = {
  id: number;
  user: string;
  assistant: string;
  tools: string;
  createdAt: number;
};
export type Checkpoint = {
  through: number;
  version: number;
  summary: MemorySummary;
  promptHash: string;
};
export function appendTurn(args: {
  sessionId: string;
  sourceKey: string;
  requestId: string;
  revealed: boolean;
  user: string;
  reply: Pick<TutorReply, "approach" | "message" | "concept" | "nextStep">;
  tools: { tool: string; allowed: boolean }[];
  promptHash: string;
  updates: MemoryUpdate[];
}) {
  const database = sessionDatabase();
  return database
    .transaction(() => {
      const inserted = database
        .prepare(
          `INSERT INTO tutor_turns
    (session_id, source_key, request_id, answer_revealed, user_text, assistant_json, tools_json, prompt_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, request_id) DO NOTHING`,
        )
        .run(
          args.sessionId,
          args.sourceKey,
          args.requestId,
          Number(args.revealed),
          args.user,
          JSON.stringify(args.reply),
          JSON.stringify(args.tools),
          args.promptHash,
          Date.now(),
        );
      if (!inserted.changes) return;
      const turnId = Number(inserted.lastInsertRowid);
      for (const update of args.updates) {
        // Evidence is never promoted to instructions. Only these enum values reach other questions.
        if (!update.evidence.trim() || !args.user.includes(update.evidence)) continue;
        if (!Object.prototype.hasOwnProperty.call(preferenceValues, update.key)) continue;
        if (update.value === null) {
          database
            .prepare("DELETE FROM tutor_preferences WHERE session_id = ? AND preference_key = ?")
            .run(args.sessionId, update.key);
        } else if ((preferenceValues[update.key] as readonly string[]).includes(update.value)) {
          database
            .prepare(
              `INSERT INTO tutor_preferences VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, preference_key) DO UPDATE SET preference_value = excluded.preference_value,
        evidence_turn_id = excluded.evidence_turn_id, evidence_text = excluded.evidence_text, updated_at = excluded.updated_at`,
            )
            .run(args.sessionId, update.key, update.value, turnId, update.evidence, Date.now());
        }
      }
    })
    .immediate();
}
export function preferences(sessionId: string) {
  return sessionDatabase()
    .prepare(
      `SELECT preference_key as key, preference_value as value, updated_at as updatedAt
    FROM tutor_preferences WHERE session_id = ? ORDER BY preference_key`,
    )
    .all(sessionId) as MemoryView["preferences"];
}
export function turns(
  sessionId: string,
  sourceKey: string,
  revealed: boolean,
  after = 0,
  limit = 100,
) {
  return sessionDatabase()
    .prepare(
      `SELECT id, user_text as user, assistant_json as assistant, tools_json as tools, created_at as createdAt
    FROM tutor_turns WHERE session_id = ? AND source_key = ? AND answer_revealed = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(sessionId, sourceKey, Number(revealed), after, limit) as StoredTurn[];
}
export function recentTurns(
  sessionId: string,
  sourceKey: string,
  revealed: boolean,
  limit: number,
) {
  return (
    sessionDatabase()
      .prepare(
        `SELECT id, user_text as user, assistant_json as assistant, tools_json as tools, created_at as createdAt
    FROM tutor_turns WHERE session_id = ? AND source_key = ? AND answer_revealed = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, sourceKey, Number(revealed), limit) as StoredTurn[]
  ).reverse();
}
export function checkpoint(
  sessionId: string,
  sourceKey: string,
  revealed: boolean,
): Checkpoint | null {
  const row = sessionDatabase()
    .prepare(
      `SELECT through_turn_id as through, version, summary_json as summary, prompt_hash as promptHash
    FROM tutor_summaries WHERE session_id = ? AND source_key = ? AND answer_revealed = ?`,
    )
    .get(sessionId, sourceKey, Number(revealed)) as
    { through: number; version: number; summary: string; promptHash: string } | undefined;
  return row ? { ...row, summary: JSON.parse(row.summary) } : null;
}
export function writeCheckpoint(args: {
  sessionId: string;
  sourceKey: string;
  revealed: boolean;
  expectedVersion: number;
  through: number;
  summary: MemorySummary;
  digest: string;
  promptHash: string;
  inputBytes: number;
  outputBytes: number;
}) {
  const database = sessionDatabase();
  const current = checkpoint(args.sessionId, args.sourceKey, args.revealed);
  if ((current?.version ?? 0) !== args.expectedVersion) return false;
  database
    .prepare(
      `INSERT INTO tutor_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, source_key, answer_revealed) DO UPDATE SET through_turn_id = excluded.through_turn_id,
    version = excluded.version, summary_json = excluded.summary_json, source_digest = excluded.source_digest,
    prompt_hash = excluded.prompt_hash, input_bytes = excluded.input_bytes, output_bytes = excluded.output_bytes, created_at = excluded.created_at`,
    )
    .run(
      args.sessionId,
      args.sourceKey,
      Number(args.revealed),
      args.through,
      args.expectedVersion + 1,
      JSON.stringify(args.summary),
      args.digest,
      args.promptHash,
      args.inputBytes,
      args.outputBytes,
      Date.now(),
    );
  return true;
}
export function memoryView(sessionId: string, questionId: number, before?: number): MemoryView {
  const { question } = questionContext(questionId);
  if (question.reviewRequired)
    throw new PracticeError("Memory is unavailable for questions under source review.", 409);
  const revealed = isRevealed(sessionId, questionId);
  const rows = sessionDatabase()
    .prepare(
      `SELECT id, user_text as user, assistant_json as assistant, created_at as createdAt
    FROM tutor_turns WHERE session_id = ? AND source_key = ? AND answer_revealed = ? AND id < ? ORDER BY id DESC LIMIT 11`,
    )
    .all(
      sessionId,
      question.sourceKey,
      Number(revealed),
      before ?? Number.MAX_SAFE_INTEGER,
    ) as Omit<StoredTurn, "tools">[];
  const selected = rows.slice(0, 10);
  const summary = checkpoint(sessionId, question.sourceKey, revealed);
  return {
    expiresAt: sessionExpires(sessionId),
    preferences: preferences(sessionId),
    summary: summary?.summary ?? null,
    summaryVersion: summary?.version ?? null,
    turns: selected.map((row) => ({
      ...row,
      assistant:
        typeof JSON.parse(row.assistant) === "string"
          ? { message: JSON.parse(row.assistant), concept: "", nextStep: "" }
          : JSON.parse(row.assistant),
    })),
    hasMore: rows.length > 10,
    nextBefore: rows.length > 10 ? selected.at(-1)!.id : null,
    scope: revealed ? "revealed" : "hidden",
  };
}
export function forgetMemory(sessionId: string, key?: PreferenceKey) {
  const database = sessionDatabase();
  database
    .transaction(() => {
      if (key)
        database
          .prepare("DELETE FROM tutor_preferences WHERE session_id = ? AND preference_key = ?")
          .run(sessionId, key);
      else {
        database.prepare("DELETE FROM tutor_turns WHERE session_id = ?").run(sessionId);
        database.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        database.prepare("DELETE FROM conversation_windows WHERE session_id = ?").run(sessionId);
      }
      // Forgetting invalidates every active response so a late completion cannot restore memories.
      database
        .prepare("UPDATE question_state SET revision = revision + 1 WHERE session_id = ?")
        .run(sessionId);
      database
        .prepare("UPDATE runs SET state = 'done' WHERE session_id = ? AND state = 'active'")
        .run(sessionId);
    })
    .immediate();
}

// Upgrade only complete turns from the still-valid cache. hide() already clears that
// cache on permission changes. Orphan/user-only turns are never durable memories.
export function importLegacyTurns(
  sessionId: string,
  questionId: number,
  sourceKey: string,
  revealed: boolean,
) {
  const database = sessionDatabase();
  database
    .transaction(() => {
      if (
        database
          .prepare("SELECT 1 FROM tutor_turns WHERE session_id = ? AND source_key = ? LIMIT 1")
          .get(sessionId, sourceKey)
      )
        return;
      const rows = database
        .prepare(
          "SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND question_id = ? ORDER BY id",
        )
        .all(sessionId, questionId) as {
        id: number;
        role: string;
        content: string;
        created_at: number;
      }[];
      let user: (typeof rows)[number] | undefined;
      for (const row of rows) {
        if (row.role === "user") user = row;
        else if (user) {
          let assistant = JSON.stringify(row.content);
          try {
            const parsed = JSON.parse(row.content);
            if (
              parsed &&
              typeof parsed.message === "string" &&
              typeof parsed.concept === "string" &&
              typeof parsed.nextStep === "string"
            )
              assistant = row.content;
          } catch {
            /* Legacy plain-text reply. */
          }
          database
            .prepare(
              `INSERT OR IGNORE INTO tutor_turns
          (session_id, source_key, request_id, answer_revealed, user_text, assistant_json, tools_json, prompt_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '[]', 'legacy-unknown', ?)`,
            )
            .run(
              sessionId,
              sourceKey,
              `legacy-${row.id}`,
              Number(revealed),
              user.content,
              assistant,
              row.created_at,
            );
          user = undefined;
        }
      }
    })
    .immediate();
}
export function conversationText(assistant: string): string {
  const parsed = JSON.parse(assistant);
  return typeof parsed === "string" ? parsed : assistant;
}

export function searchConversation(
  sessionId: string,
  questionId: number,
  query: string,
  limit: number,
) {
  const { question } = questionContext(questionId);
  if (question.reviewRequired) throw new PracticeError("This question needs source review.", 409);
  // Escape LIKE metacharacters; query never becomes SQL or changes the learner/question scope.
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = sessionDatabase()
    .prepare(
      `SELECT id, user_text as user, assistant_json as assistant, created_at as createdAt
    FROM tutor_turns WHERE session_id = ? AND source_key = ? AND answer_revealed = ?
    AND (user_text LIKE ? ESCAPE '\\' OR assistant_json LIKE ? ESCAPE '\\') ORDER BY id DESC LIMIT ?`,
    )
    .all(
      sessionId,
      question.sourceKey,
      Number(isRevealed(sessionId, questionId)),
      pattern,
      pattern,
      Math.min(3, Math.max(1, limit)),
    ) as Omit<StoredTurn, "tools">[];
  return {
    scope:
      "Completed conversations for this learner, this question, and its current reveal phase only",
    turns: rows.map((row) => {
      const text = conversationText(row.assistant);
      return { ...row, assistant: text.slice(0, 2400), truncated: text.length > 2400 };
    }),
  };
}
