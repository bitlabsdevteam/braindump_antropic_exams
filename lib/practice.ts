import crypto from "node:crypto";
import {
  getAnswer,
  getCertification,
  getCertificationForQuestion,
  getQuestion,
  getQuestions,
} from "./db";
import { hide, sessionDatabase, sessionExpires } from "../agents/ai-tutor/context/session";
import type { Question } from "./types";
import type { AttemptKind, DraftState, PracticeSnapshot, Recommendation } from "./practice-types";

export class PracticeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
type StateRow = {
  draft: string;
  reasoning: string;
  generation: number;
  revision: number;
  hint_count: number;
  assisted: number;
  exposed: number;
  visible: number;
  submitted: number;
};
type AttemptRow = {
  id: string;
  source_key: string;
  domain_name: string | null;
  correct: number;
  kind: AttemptKind;
  created_at: number;
  generation: number;
  selected: string;
};
export function questionContext(id: number) {
  const question = getQuestion(id);
  const certification = getCertificationForQuestion(id);
  if (!question || !certification) throw new PracticeError("Question not found", 404);
  return { question, certification };
}
export function validSelections(
  question: Question,
  selected: unknown,
  complete = false,
): selected is string[] {
  if (
    !Array.isArray(selected) ||
    selected.some((key) => typeof key !== "string") ||
    new Set(selected).size !== selected.length
  )
    return false;
  const required =
    question.type === "scenario_matching" ? question.matchItems.length : question.selectionCount;
  if (selected.length > required || (complete && selected.length !== required)) return false;
  if (question.type === "scenario_matching") {
    const pairs = selected.map((key) => key.split(":"));
    return (
      new Set(pairs.map(([item]) => item)).size === pairs.length &&
      pairs.every(
        ([item, option, extra]) =>
          extra === undefined &&
          question.matchItems.some((value) => value.key === item) &&
          question.options.some((value) => value.key === option),
      )
    );
  }
  return selected.every((key) => question.options.some((option) => option.key === key));
}
export function gradeAnswer(selected: string[], correct: string[]) {
  return (
    selected.length === correct.length &&
    new Set(selected).size === selected.length &&
    selected.every((key) => correct.includes(key))
  );
}
export function getState(id: string, questionId: number): DraftState {
  const { question, certification } = questionContext(questionId);
  const database = sessionDatabase();
  database
    .prepare(
      "INSERT OR IGNORE INTO question_state(session_id, source_key, certification_slug, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, question.sourceKey, certification.slug, Date.now());
  const row = database
    .prepare("SELECT * FROM question_state WHERE session_id = ? AND source_key = ?")
    .get(id, question.sourceKey) as StateRow;
  const attempt = database
    .prepare(
      "SELECT correct, kind FROM attempts WHERE session_id = ? AND source_key = ? AND generation = ?",
    )
    .get(id, question.sourceKey, row.generation) as
    { correct: number; kind: AttemptKind } | undefined;
  return {
    selectedKeys: JSON.parse(row.draft),
    reasoning: row.reasoning,
    generation: row.generation,
    revision: row.revision,
    hintCount: row.hint_count,
    submitted: Boolean(row.submitted),
    exposed: Boolean(row.exposed),
    visible: Boolean(row.visible),
    result: attempt ? { correct: Boolean(attempt.correct), kind: attempt.kind } : null,
  };
}
function currentState(id: string, questionId: number, revision: unknown) {
  const state = getState(id, questionId);
  if (!Number.isInteger(revision) || state.revision !== revision)
    throw new PracticeError(
      "This question changed. Reload the latest progress before trying again.",
      409,
    );
  return state;
}
export function saveDraft(
  id: string,
  questionId: number,
  selected: unknown,
  reasoning: unknown,
  revision: unknown,
) {
  const { question } = questionContext(questionId);
  if (
    !validSelections(question, selected) ||
    typeof reasoning !== "string" ||
    reasoning.length > 1000
  )
    throw new PracticeError("Invalid selections or reasoning");
  return sessionDatabase()
    .transaction(() => {
      const state = currentState(id, questionId, revision);
      if (state.submitted || state.visible)
        throw new PracticeError("Start a retry to change this answer.", 409);
      sessionDatabase()
        .prepare(
          "UPDATE question_state SET draft = ?, reasoning = ?, revision = revision + 1, updated_at = ? WHERE session_id = ? AND source_key = ?",
        )
        .run(JSON.stringify(selected), reasoning, Date.now(), id, question.sourceKey);
      return getState(id, questionId);
    })
    .immediate();
}
export function revealAnswer(id: string, questionId: number) {
  const { question } = questionContext(questionId);
  const answer = getAnswer(questionId);
  if (!answer) throw new PracticeError("Source answer unavailable", 404);
  getState(id, questionId);
  sessionDatabase()
    .prepare(
      "UPDATE question_state SET exposed = 1, visible = 1, revision = revision + 1 WHERE session_id = ? AND source_key = ?",
    )
    .run(id, question.sourceKey);
  return answer;
}
export function submitAttempt(
  id: string,
  questionId: number,
  requestId: string,
  revision: unknown,
) {
  const { question, certification } = questionContext(questionId);
  const database = sessionDatabase();
  return database
    .transaction(() => {
      const previous = database
        .prepare("SELECT * FROM attempts WHERE session_id = ? AND request_id = ?")
        .get(id, requestId) as AttemptRow | undefined;
      if (previous) {
        const state = getState(id, questionId);
        if (
          previous.source_key !== question.sourceKey ||
          previous.generation !== state.generation ||
          !state.visible
        )
          throw new PracticeError("That submission is no longer active.", 409);
        return { state, answer: getAnswer(questionId) };
      }
      const state = currentState(id, questionId, revision);
      if (state.submitted || state.visible)
        throw new PracticeError("Start a retry before submitting again.", 409);
      if (question.reviewRequired)
        throw new PracticeError("This question has a source conflict and cannot be scored.", 409);
      if (!validSelections(question, state.selectedKeys, true))
        throw new PracticeError("Complete all required selections before submitting.");
      const answer = getAnswer(questionId);
      if (!answer) throw new PracticeError("Source answer unavailable", 404);
      const assisted = (
        database
          .prepare("SELECT assisted FROM question_state WHERE session_id = ? AND source_key = ?")
          .get(id, question.sourceKey) as { assisted: number }
      ).assisted;
      const kind: AttemptKind = state.exposed ? "review" : assisted ? "assisted" : "independent";
      database
        .prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          crypto.randomUUID(),
          id,
          requestId,
          question.sourceKey,
          certification.slug,
          question.domainName,
          JSON.stringify(state.selectedKeys),
          Number(gradeAnswer(state.selectedKeys, answer.correctKeys)),
          kind,
          state.hintCount,
          state.generation,
          Date.now(),
        );
      database
        .prepare("UPDATE question_state SET submitted = 1 WHERE session_id = ? AND source_key = ?")
        .run(id, question.sourceKey);
      revealAnswer(id, questionId);
      return { state: getState(id, questionId), answer };
    })
    .immediate();
}
export function retryQuestion(id: string, questionId: number, revision: unknown) {
  const { question } = questionContext(questionId);
  return sessionDatabase()
    .transaction(() => {
      const state = currentState(id, questionId, revision);
      if (!state.submitted && !state.exposed)
        throw new PracticeError("Submit or reveal this question before starting a retry.");
      hide(id, questionId);
      sessionDatabase()
        .prepare(
          "UPDATE question_state SET draft = '[]', reasoning = '', generation = generation + 1, hint_count = 0, assisted = 0, submitted = 0, updated_at = ? WHERE session_id = ? AND source_key = ?",
        )
        .run(Date.now(), id, question.sourceKey);
      return getState(id, questionId);
    })
    .immediate();
}
export function revisionMatches(id: string, questionId: number, revision: number) {
  const key = getQuestion(questionId)?.sourceKey;
  const row = key
    ? (sessionDatabase()
        .prepare("SELECT revision FROM question_state WHERE session_id = ? AND source_key = ?")
        .get(id, key) as { revision: number } | undefined)
    : undefined;
  return row?.revision === revision;
}
export function recordAssistance(id: string, questionId: number, hint: boolean) {
  const { question } = questionContext(questionId);
  sessionDatabase()
    .prepare(
      "UPDATE question_state SET assisted = 1, hint_count = hint_count + ? WHERE session_id = ? AND source_key = ? AND visible = 0 AND submitted = 0",
    )
    .run(Number(hint), id, question.sourceKey);
}
export function setPracticeSettings(
  id: string,
  slug: string,
  action: "navigate" | "start",
  value: unknown,
) {
  const certification = getCertification(slug);
  if (!certification) throw new PracticeError("Certification not found", 404);
  const database = sessionDatabase();
  database
    .prepare(
      "INSERT OR IGNORE INTO practice_settings(session_id, certification_slug) VALUES (?, ?)",
    )
    .run(id, slug);
  if (action === "navigate") {
    if (
      typeof value !== "string" ||
      !getQuestions(slug).some((question) => question.sourceKey === value)
    )
      throw new PracticeError("Invalid question");
    database.transaction(() => {
      database
        .prepare(
          "UPDATE practice_settings SET question_key = ? WHERE session_id = ? AND certification_slug = ?",
        )
        .run(value, id, slug);
      // Invalidate in-flight explanations when the learner changes questions.
      database
        .prepare(
          "UPDATE question_state SET revision = revision + 1 WHERE session_id = ? AND certification_slug = ?",
        )
        .run(id, slug);
    })();
  } else {
    if (typeof value !== "boolean") throw new PracticeError("Invalid timer choice");
    database
      .prepare(
        "UPDATE practice_settings SET started = 1, deadline = ? WHERE session_id = ? AND certification_slug = ? AND started = 0",
      )
      .run(value ? Date.now() + (certification.timeLimitMinutes || 120) * 60_000 : null, id, slug);
  }
}
export function restartExam(id: string, slug: string): PracticeSnapshot {
  const certification = getCertification(slug);
  if (!certification) throw new PracticeError("Certification not found", 404);
  const questions = getQuestions(slug);
  if (!questions.length) throw new PracticeError("This exam has no questions to restart.", 409);
  const database = sessionDatabase();
  return database
    .transaction(() => {
      const settings = database
        .prepare(
          "SELECT deadline FROM practice_settings WHERE session_id = ? AND certification_slug = ?",
        )
        .get(id, slug) as { deadline: number | null } | undefined;
      const keys = JSON.stringify(questions.map((question) => question.sourceKey));
      const ids = JSON.stringify(questions.map((question) => question.id));
      database
        .prepare("DELETE FROM attempts WHERE session_id = ? AND certification_slug = ?")
        .run(id, slug);
      // Keep revision counters monotonic: an old tab/request must never match a new attempt.
      database
        .prepare(
          `UPDATE question_state SET draft = '[]', reasoning = '',
      generation = generation + 1, revision = revision + 1, hint_count = 0, assisted = 0,
      exposed = 0, visible = 0, submitted = 0, updated_at = ?
      WHERE session_id = ? AND certification_slug = ?`,
        )
        .run(Date.now(), id, slug);
      // Summaries and preferences grounded in these conversations cascade with their evidence.
      database
        .prepare(
          `DELETE FROM tutor_turns WHERE session_id = ?
      AND source_key IN (SELECT value FROM json_each(?))`,
        )
        .run(id, keys);
      for (const table of ["messages", "conversation_windows", "reveals", "outcomes"]) {
        database
          .prepare(
            `DELETE FROM ${table} WHERE session_id = ?
        AND question_id IN (SELECT value FROM json_each(?))`,
          )
          .run(id, ids);
      }
      database
        .prepare(
          `INSERT INTO practice_settings(session_id, certification_slug, question_key, started, deadline)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT(session_id, certification_slug) DO UPDATE SET
      question_key = excluded.question_key, started = 1, deadline = excluded.deadline`,
        )
        .run(
          id,
          slug,
          questions[0].sourceKey,
          settings?.deadline != null
            ? Date.now() + (certification.timeLimitMinutes ?? 120) * 60_000
            : null,
        );
      return practiceSnapshot(id, slug);
    })
    .immediate();
}
export function practiceSnapshot(id: string, slug: string): PracticeSnapshot {
  if (!getCertification(slug)) throw new PracticeError("Certification not found", 404);
  const questions = getQuestions(slug);
  const database = sessionDatabase();
  const existing = new Set(
    (
      database
        .prepare(
          "SELECT source_key FROM question_state WHERE session_id = ? AND certification_slug = ?",
        )
        .all(id, slug) as { source_key: string }[]
    ).map((row) => row.source_key),
  );
  const states: Record<string, DraftState> = {};
  for (const question of questions)
    if (existing.has(question.sourceKey)) states[question.sourceKey] = getState(id, question.id);
  const attempts = database
    .prepare(
      "SELECT * FROM attempts WHERE session_id = ? AND certification_slug = ? ORDER BY created_at, rowid",
    )
    .all(id, slug) as AttemptRow[];
  const first = new Map<string, AttemptRow>();
  const latest = new Map<string, AttemptRow>();
  for (const attempt of attempts) {
    if (!first.has(attempt.source_key)) first.set(attempt.source_key, attempt);
    latest.set(attempt.source_key, attempt);
  }
  const independent = [...first.values()].filter((row) => row.kind === "independent");
  // The exam mark is one point per scorable question's first saved attempt.
  // Never grade unsent drafts or let later retries rewrite the original mark.
  const scorable = questions.filter((question) => !question.reviewRequired);
  const firstScorable = scorable.flatMap((question) => {
    const attempt = first.get(question.sourceKey);
    return attempt ? [attempt] : [];
  });
  const correct = firstScorable.filter((attempt) => attempt.correct).length;
  const resultDomains = [...new Set(scorable.map((question) => question.domainName || "General"))];
  const names = [...new Set(questions.map((question) => question.domainName || "General"))];
  const settings = database
    .prepare(
      "SELECT question_key as questionKey, started, deadline FROM practice_settings WHERE session_id = ? AND certification_slug = ?",
    )
    .get(id, slug) as
    { questionKey: string | null; started: number; deadline: number | null } | undefined;
  return {
    states,
    result: {
      correct,
      total: scorable.length,
      attempted: firstScorable.length,
      unanswered: scorable.length - firstScorable.length,
      excluded: questions.length - scorable.length,
      percentage: scorable.length ? Math.round((correct / scorable.length) * 100) : 0,
      independent: firstScorable.filter((attempt) => attempt.kind === "independent").length,
      assisted: firstScorable.filter((attempt) => attempt.kind === "assisted").length,
      review: firstScorable.filter((attempt) => attempt.kind === "review").length,
      unansweredKeys: scorable
        .filter((question) => !first.has(question.sourceKey))
        .map((question) => question.sourceKey),
      domains: resultDomains.map((name) => {
        const domainQuestions = scorable.filter(
          (question) => (question.domainName || "General") === name,
        );
        const domainAttempts = domainQuestions.flatMap((question) => {
          const attempt = first.get(question.sourceKey);
          return attempt ? [attempt] : [];
        });
        return {
          name,
          total: domainQuestions.length,
          attempted: domainAttempts.length,
          correct: domainAttempts.filter((attempt) => attempt.correct).length,
        };
      }),
    },
    expiresAt: sessionExpires(id),
    settings: settings
      ? { ...settings, started: Boolean(settings.started) }
      : { questionKey: null, started: false, deadline: null },
    mistakeKeys: [...latest.values()]
      .filter((row) => !row.correct)
      .sort((a, b) => a.created_at - b.created_at)
      .map((row) => row.source_key),
    progress: {
      attempted: first.size,
      independent: independent.length,
      independentCorrect: independent.filter((row) => row.correct).length,
      assisted: attempts.filter((row) => row.kind === "assisted").length,
      reviews: attempts.filter((row) => row.kind === "review").length,
      reviewCorrect: attempts.filter((row) => row.kind === "review" && row.correct).length,
      domains: names.map((name) => ({
        name,
        attempted: [...first.values()].filter((row) => (row.domain_name || "General") === name)
          .length,
        independent: independent.filter((row) => (row.domain_name || "General") === name).length,
        correct: independent.filter((row) => (row.domain_name || "General") === name && row.correct)
          .length,
      })),
    },
  };
}
export function recommendations(id: string, questionId: number): Recommendation[] {
  const { question, certification } = questionContext(questionId);
  const snapshot = practiceSnapshot(id, certification.slug);
  const all = getQuestions(certification.slug).filter(
    (candidate) => candidate.id !== questionId && !candidate.reviewRequired,
  );
  const mistakes = snapshot.mistakeKeys
    .map((key) => all.find((candidate) => candidate.sourceKey === key))
    .filter((candidate): candidate is Question => Boolean(candidate));
  const unattempted = all.filter(
    (candidate) =>
      !sessionDatabase()
        .prepare("SELECT 1 FROM attempts WHERE session_id = ? AND source_key = ?")
        .get(id, candidate.sourceKey),
  );
  const ordered = [
    ...mistakes.map((candidate) => ({ candidate, reason: "Revisit an unresolved mistake" })),
    ...unattempted
      .filter((candidate) => candidate.domainNumber === question.domainNumber)
      .map((candidate) => ({ candidate, reason: "Practice another question in this domain" })),
    ...unattempted
      .filter((candidate) => candidate.domainNumber !== question.domainNumber)
      .map((candidate) => ({ candidate, reason: "Explore another domain in this certification" })),
  ];
  return ordered.slice(0, 3).map(({ candidate, reason }) => ({
    id: candidate.id,
    sourceKey: candidate.sourceKey,
    prompt: candidate.prompt,
    domainName: candidate.domainName,
    scenarioTitle: candidate.scenarioTitle,
    type: candidate.type,
    reason,
  }));
}
export function learningContext(id: string, slug: string, excludedKey: string) {
  return sessionDatabase()
    .prepare(
      "SELECT domain_name as domainName, COUNT(*) as attempts, SUM(correct) as correct FROM attempts WHERE session_id = ? AND certification_slug = ? AND source_key != ? AND kind = 'independent' GROUP BY domain_name",
    )
    .all(id, slug, excludedKey);
}
