import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { TutorServiceError } from "../lib/tutor-errors";
import type { MemorySummary } from "../lib/tutor-memory-types";

const directory = mkdtempSync(path.join(tmpdir(), "chiikawa-memory-test-"));
process.env.EXAMS_DB_PATH = path.join(directory, "exams.db");
process.env.LEARNING_DB_PATH = path.join(directory, "learning.db");
execFileSync(process.execPath, ["scripts/seed.mjs"], { env: process.env, stdio: "pipe" });
const sessions: typeof import("../agents/ai-tutor/context/session") = require("../agents/ai-tutor/context/session");
const store: typeof import("../agents/ai-tutor/memory/store") = require("../agents/ai-tutor/memory/store");
const compaction: typeof import("../agents/ai-tutor/memory/compaction") = require("../agents/ai-tutor/memory/compaction");
const migration: typeof import("../agents/ai-tutor/memory/schema") = require("../agents/ai-tutor/memory/schema");
const practice: typeof import("../lib/practice") = require("../lib/practice");
const bank: typeof import("../lib/db") = require("../lib/db");
const runtime: typeof import("../agents/ai-tutor/runtime") = require("../agents/ai-tutor/runtime");
const agentTools: typeof import("../agents/ai-tutor/tools") = require("../agents/ai-tutor/tools");
const route: typeof import("../app/api/tutor/memory/route") = require("../app/api/tutor/memory/route");
const questions = bank.getQuestions("architect-professional");
const q = questions[0];
const final = {
  type: "final" as const,
  approach: "Take one step.",
  message: "A neutral explanation.",
  concept: "Compare constraints.",
  nextStep: "What do you notice?",
};
const fresh = () => {
  const id = sessions.ensureSession();
  practice.getState(id, q.id);
  return id;
};
function seed(id: string, count: number, revealed = false) {
  const offset = store.recentTurns(id, q.sourceKey, revealed, 1).at(-1)?.id ?? 0;
  for (let i = 0; i < count; i++)
    store.appendTurn({
      sessionId: id,
      sourceKey: q.sourceKey,
      requestId: `seed-${revealed}-${offset}-${i}`,
      revealed,
      user:
        i === 0
          ? "I confuse context size with output size; help me separate them."
          : `Learning follow-up ${offset + i}: ${"Please use a neutral example. ".repeat(8)}`,
      reply: {
        ...final,
        message: `${"The discussion concerns input and output limits. ".repeat(8)} Turn ${offset + i}.`,
      },
      tools: [],
      promptHash: "fixture",
      updates: [],
    });
}
function summary(input: string): MemorySummary {
  const data = JSON.parse(input);
  return {
    goal: "Distinguish context size from output size.",
    learningNotes: [
      {
        text: "The learner initially confused context size and output size; continue with their distinction.",
        evidenceTurnIds: [
          data.previousSummary?.learningNotes[0]?.evidenceTurnIds[0] ?? data.turns[0].id,
        ],
      },
    ],
    openQuestions: ["How do reserved output tokens affect usable input?"],
    nextStep: "Ask for a neutral example.",
  };
}
const prepare = (id: string, extra: Partial<Parameters<typeof compaction.prepareMemory>[0]> = {}) =>
  compaction.prepareMemory({
    sessionId: id,
    sourceKey: q.sourceKey,
    revealed: false,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    model: async ({ input }) => summary(input),
    ...extra,
  });
function fixture(id = fresh()) {
  const state = practice.getState(id, q.id);
  const context = agentTools.createContext(q.id, {
    selectedKeys: state.selectedKeys,
    answerRevealed: state.visible,
    reasoning: state.reasoning,
    hintStage: 1,
    intent: "follow_up",
    revision: state.revision,
  });
  const request = {
    sessionId: id,
    questionId: q.id,
    requestId: crypto.randomUUID(),
    message: "Please use brief examples.",
    learnerState: context.state,
  };
  assert.ok(sessions.beginRun(id, request.requestId));
  return { request, context };
}
after(() => {
  sessions.sessionDatabase().close();
  rmSync(directory, { recursive: true, force: true });
});

test("memory migration is idempotent, constrained, durable across processes, and has a rollback", () => {
  const id = fresh();
  seed(id, 2);
  migration.migrateMemory(sessions.sessionDatabase());
  migration.migrateMemory(sessions.sessionDatabase());
  assert.equal(store.turns(id, q.sourceKey, false).length, 2);
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `const Database=require('better-sqlite3');const db=new Database(process.env.LEARNING_DB_PATH); console.log(db.prepare('SELECT COUNT(*) as count FROM tutor_turns WHERE session_id = ?').get(process.argv[1]).count);`,
      id,
    ],
    { env: process.env, encoding: "utf8" },
  );
  assert.equal(output.trim(), "2");
  assert.throws(
    () =>
      sessions
        .sessionDatabase()
        .prepare("INSERT INTO tutor_preferences VALUES (?, 'depth', 'brief', 999999, 'brief', 0)")
        .run(id),
    /FOREIGN KEY/,
  );
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE learning_migrations(version INTEGER PRIMARY KEY);",
  );
  migration.migrateMemory(db);
  migration.rollbackMemory(db);
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE name LIKE 'tutor_%'").get() as {
        count: number;
      }
    ).count,
    0,
  );
  db.close();
});

test("completed exchanges persist explicit grounded preferences; they cross questions without copying conversation text", async () => {
  const { request, context } = fixture();
  await runtime.runTutorAgent(request, context, {
    model: async () => ({
      ...final,
      memoryUpdates: [
        { key: "depth", value: "brief", evidence: "Please use brief examples." },
        { key: "style", value: "examples", evidence: "Please use brief examples." },
      ],
    }),
  });
  sessions.finishRun(request.sessionId, request.requestId);
  assert.equal(store.turns(request.sessionId, q.sourceKey, false).length, 1);
  assert.equal(store.preferences(request.sessionId).length, 2);
  const next = await compaction.prepareMemory({
    sessionId: request.sessionId,
    sourceKey: questions[1].sourceKey,
    revealed: false,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  assert.equal(next.recent.length, 0);
  assert.equal(next.preferences.length, 2);
  assert.equal(store.preferences(fresh()).length, 0);
  const update = fixture(request.sessionId);
  update.request.message = "Please be detailed now.";
  await runtime.runTutorAgent(update.request, update.context, {
    model: async () => ({
      ...final,
      memoryUpdates: [
        { key: "depth", value: "detailed", evidence: "Please be detailed now." },
        { key: "experience", value: "advanced", evidence: "I am an expert" },
      ],
    }),
  });
  sessions.finishRun(update.request.sessionId, update.request.requestId);
  assert.equal(
    store.preferences(request.sessionId).find((x) => x.key === "depth")?.value,
    "detailed",
  );
  assert.ok(!store.preferences(request.sessionId).some((x) => x.key === "experience"));
});

test("compaction replaces old context with a source-linked summary and recent whole turns, without deleting history", async () => {
  const id = fresh();
  seed(id, 20);
  const all = store.turns(id, q.sourceKey, false);
  let calls = 0;
  const trace: Record<string, unknown>[] = [];
  const result = await prepare(id, {
    model: async ({ input }) => {
      calls++;
      const data = JSON.parse(input);
      assert.equal(data.turns.length, 17);
      assert.equal(data.turns[0].user, all[0].user);
      return summary(input);
    },
    onTrace: (data) => trace.push(data),
  });
  assert.equal(calls, 1);
  assert.equal(result.compaction, "completed");
  assert.equal(result.recent.length, 3);
  assert.deepEqual(
    result.recent.map((x) => x.id),
    all.slice(-3).map((x) => x.id),
  );
  assert.equal(result.summaryThrough, all[16].id);
  assert.equal(result.omittedOlderTurns, false);
  assert.ok(result.summary?.learningNotes[0].text.includes("context size"));
  assert.equal(store.turns(id, q.sourceKey, false).length, 20);
  assert.ok(
    trace.some((x) => x.event === "compaction" && Number(x.outputBytes) < Number(x.inputBytes)),
  );
  assert.equal(
    (
      await prepare(id, {
        model: async () => {
          throw Error("Should reuse checkpoint");
        },
      })
    ).compaction,
    "not_needed",
  );
  seed(id, 9);
  await prepare(id);
  assert.equal(store.checkpoint(id, q.sourceKey, false)?.version, 2);
  assert.equal(
    store.checkpoint(id, q.sourceKey, false)?.summary.learningNotes[0].evidenceTurnIds[0],
    all[0].id,
  );
});

test("runtime actually uses compacted memory and recalls the older learning goal", async () => {
  const id = fresh();
  seed(id, 20);
  const { request, context } = fixture(id);
  await runtime.runTutorAgent(request, context, {
    compactor: async ({ input }) => summary(input),
    model: async ({ input }) => {
      const data = JSON.parse(input);
      assert.equal(data.conversation.length, 6);
      assert.match(data.memory.summary.goal, /context size/);
      assert.equal(data.memory.omittedOlderTurns, false);
      return final;
    },
  });
  sessions.finishRun(id, request.requestId);
  assert.equal(store.turns(id, q.sourceKey, false).length, 21);
});

test("failed or malformed compaction falls back honestly and retains history and the last valid checkpoint", async () => {
  const id = fresh();
  seed(id, 20);
  const result = await prepare(id, {
    model: async () => {
      throw new TutorServiceError("unavailable");
    },
  });
  assert.equal(result.compaction, "unavailable");
  assert.equal(result.omittedOlderTurns, true);
  assert.equal(result.recent.length, 3);
  assert.equal(store.checkpoint(id, q.sourceKey, false), null);
  assert.equal(store.turns(id, q.sourceKey, false).length, 20);
  await prepare(id);
  const previous = store.checkpoint(id, q.sourceKey, false);
  seed(id, 10);
  const invalid = await prepare(id, {
    model: async () => ({
      goal: "Invented",
      learningNotes: [{ text: "Fake fact", evidenceTurnIds: [9999999] }],
      openQuestions: [],
      nextStep: "",
    }),
  });
  assert.equal(invalid.compaction, "unavailable");
  assert.deepEqual(store.checkpoint(id, q.sourceKey, false), previous);
});

test("cancel, hide, navigation, forget, reset and expiry prevent stale summary writes", async () => {
  for (const action of ["cancel", "hide", "navigate", "forget", "reset", "expire"]) {
    const id = fresh();
    seed(id, 20);
    const { request, context } = fixture(id);
    const abort = new AbortController();
    await assert.rejects(
      runtime.runTutorAgent({ ...request, signal: abort.signal }, context, {
        compactor: async ({ input }) => {
          if (action === "cancel") abort.abort();
          if (action === "hide") sessions.hide(id, q.id);
          if (action === "navigate")
            practice.setPracticeSettings(
              id,
              "architect-professional",
              "navigate",
              questions[1].sourceKey,
            );
          if (action === "forget") store.forgetMemory(id);
          if (action === "reset") sessions.resetSession(id);
          if (action === "expire")
            sessions
              .sessionDatabase()
              .prepare("UPDATE sessions SET created_at = 0 WHERE id = ?")
              .run(id);
          return summary(input);
        },
        model: async () => {
          throw Error("Stale run must not reach model");
        },
      }),
    );
    assert.equal(store.checkpoint(id, q.sourceKey, false), null);
    sessions.finishRun(id, request.requestId);
  }
});

test("hiding a source answer excludes all revealed history and summaries from runtime and API", async () => {
  const id = fresh();
  seed(id, 2);
  practice.revealAnswer(id, q.id);
  store.appendTurn({
    sessionId: id,
    sourceKey: q.sourceKey,
    requestId: "sensitive-revealed",
    revealed: true,
    user: "Explain the answer.",
    reply: { ...final, message: "REVEALED_SOURCE_SECRET" },
    tools: [],
    promptHash: "fixture",
    updates: [],
  });
  const revealed = store.memoryView(id, q.id);
  assert.ok(JSON.stringify(revealed).includes("REVEALED_SOURCE_SECRET"));
  sessions.hide(id, q.id);
  assert.ok(!JSON.stringify(store.memoryView(id, q.id)).includes("REVEALED_SOURCE_SECRET"));
  const { request, context } = fixture(id);
  await runtime.runTutorAgent(request, context, {
    model: async ({ input }) => {
      assert.ok(!input.includes("REVEALED_SOURCE_SECRET"));
      return final;
    },
  });
  sessions.finishRun(id, request.requestId);
  const response = await route.GET(
    new Request(`http://localhost/api/tutor/memory?questionId=${q.id}&answerRevealed=true`, {
      headers: { cookie: `ai_tutor_session=${id}` },
    }),
  );
  assert.ok(!(await response.text()).includes("REVEALED_SOURCE_SECRET"));
});

test("memory survives idle cache expiry; forgetting and 30-day expiry erase memory without erasing grades early", () => {
  const id = fresh();
  seed(id, 2);
  practice.saveDraft(id, q.id, [q.options[0].key], "", 0);
  practice.submitAttempt(id, q.id, "attempt-memory-test", practice.getState(id, q.id).revision);
  sessions
    .sessionDatabase()
    .prepare("UPDATE sessions SET touched_at = ? WHERE id = ?")
    .run(Date.now() - 3 * 60 * 60 * 1000, id);
  sessions.ensureSession(id);
  assert.equal(store.turns(id, q.sourceKey, false).length, 2);
  store.forgetMemory(id);
  assert.equal(store.turns(id, q.sourceKey, false).length, 0);
  assert.equal(practice.practiceSnapshot(id, "architect-professional").progress.attempted, 1);
  seed(id, 1);
  sessions.sessionDatabase().prepare("UPDATE sessions SET created_at = 0 WHERE id = ?").run(id);
  assert.notEqual(sessions.ensureSession(id), id);
  for (const table of ["tutor_turns", "tutor_summaries", "tutor_preferences"])
    assert.equal(
      (
        sessions
          .sessionDatabase()
          .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE session_id = ?`)
          .get(id) as { count: number }
      ).count,
      0,
    );
});

test("partial, failed and cancelled outputs never become durable memory", async () => {
  const { request, context } = fixture();
  await assert.rejects(
    runtime.runTutorAgent(request, context, {
      model: async ({ onDelta }) => {
        onDelta?.({ field: "message", text: "Partial hint" });
        throw new TutorServiceError("invalid_output");
      },
      onEvent: () => {},
    }),
  );
  sessions.finishRun(request.sessionId, request.requestId);
  assert.equal(store.turns(request.sessionId, q.sourceKey, false).length, 0);
  assert.equal(store.preferences(request.sessionId).length, 0);
});

test("memory API validates scope, cursors and origins and never accepts a caller-selected session", async () => {
  const id = fresh();
  seed(id, 12);
  const other = fresh();
  const get = (suffix: string, cookie = id) =>
    route.GET(
      new Request(`http://localhost/api/tutor/memory?questionId=${q.id}${suffix}`, {
        headers: { cookie: `ai_tutor_session=${cookie}` },
      }),
    );
  const first = await (await get("")).json();
  assert.equal(first.turns.length, 10);
  assert.equal(first.hasMore, true);
  const second = await (await get(`&before=${first.nextBefore}`)).json();
  assert.equal(second.turns.length, 2);
  assert.equal((await (await get(`&sessionId=${id}`, other)).json()).turns.length, 0);
  assert.equal((await get("&before=NaN")).status, 400);
  assert.equal(
    (await route.GET(new Request("http://localhost/api/tutor/memory?questionId=999999"))).status,
    404,
  );
  assert.equal(
    (
      await route.DELETE(
        new Request("http://localhost/api/tutor/memory", {
          method: "DELETE",
          headers: { origin: "https://evil.test", cookie: `ai_tutor_session=${id}` },
          body: JSON.stringify({ questionId: q.id }),
        }),
      )
    ).status,
    403,
  );
  assert.equal(store.turns(id, q.sourceKey, false).length, 12);
});

test("scoped conversation search retrieves archived evidence but never another learner, question, or reveal phase", () => {
  const id = fresh();
  seed(id, 12);
  const result = store.searchConversation(id, q.id, "context size", 3);
  assert.equal(result.turns.length, 1);
  assert.match(result.turns[0].user, /confuse/);
  assert.equal(store.searchConversation(id, questions[1].id, "context size", 3).turns.length, 0);
  assert.equal(store.searchConversation(fresh(), q.id, "context size", 3).turns.length, 0);
  assert.equal(store.searchConversation(id, q.id, "%", 3).turns.length, 0);
  practice.revealAnswer(id, q.id);
  assert.equal(store.searchConversation(id, q.id, "context size", 3).turns.length, 0);
  sessions.hide(id, q.id);
  assert.equal(store.searchConversation(id, q.id, "context size", 3).turns.length, 1);
});

test("configured model window bounds both summarizer and tutor requests without splitting turns", async () => {
  const old = process.env.FOUNDRY_CONTEXT_WINDOW_TOKENS;
  process.env.FOUNDRY_CONTEXT_WINDOW_TOKENS = "32768";
  try {
    const id = fresh();
    seed(id, 30);
    const budget = compaction.contextBudget().inputBytes;
    await prepare(id, {
      model: async ({ system, input }) => {
        assert.ok(compaction.bytes(system) + compaction.bytes(input) <= budget);
        return summary(input);
      },
    });
    const { request, context } = fixture(id);
    await runtime.runTutorAgent(request, context, {
      compactor: async ({ input }) => summary(input),
      model: async ({ system, input }) => {
        assert.ok(compaction.bytes(system) + compaction.bytes(input) <= budget);
        const history = JSON.parse(input).conversation;
        assert.equal(history.length % 2, 0);
        return final;
      },
    });
    sessions.finishRun(id, request.requestId);
  } finally {
    if (old === undefined) delete process.env.FOUNDRY_CONTEXT_WINDOW_TOKENS;
    else process.env.FOUNDRY_CONTEXT_WINDOW_TOKENS = old;
  }
});

test("a superseded checkpoint write cannot overwrite a newer summary", async () => {
  const id = fresh();
  seed(id, 20);
  await prepare(id);
  const previous = store.checkpoint(id, q.sourceKey, false)!;
  assert.equal(
    store.writeCheckpoint({
      sessionId: id,
      sourceKey: q.sourceKey,
      revealed: false,
      expectedVersion: 0,
      through: previous.through,
      summary: { ...previous.summary, goal: "Stale summary" },
      digest: "stale",
      promptHash: "stale",
      inputBytes: 1,
      outputBytes: 1,
    }),
    false,
  );
  assert.deepEqual(store.checkpoint(id, q.sourceKey, false), previous);
});

test("the run deadline bounds a compactor that ignores abort without losing history", async () => {
  const id = fresh();
  seed(id, 20);
  const { request, context } = fixture(id);
  const started = Date.now();
  await assert.rejects(
    runtime.runTutorAgent(request, context, {
      timeoutMs: 15,
      compactor: () => new Promise(() => {}),
      model: async () => {
        throw Error("must not run");
      },
    }),
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(store.checkpoint(id, q.sourceKey, false), null);
  assert.equal(store.turns(id, q.sourceKey, false).length, 20);
  sessions.finishRun(id, request.requestId);
});

test("model memory updates are strictly validated and never emitted as streamed learner text", () => {
  const { parseAgentModelOutput }: typeof import("../lib/foundry") = require("../lib/foundry");
  const {
    StreamedTutorJson,
  }: typeof import("../lib/streamed-tutor-json") = require("../lib/streamed-tutor-json");
  const value = {
    ...final,
    tool: null,
    arguments: null,
    relatedQuestionIds: [],
    memoryUpdates: [{ key: "depth", value: "brief", evidence: "PRIVATE_PREFERENCE_EVIDENCE" }],
  };
  assert.equal(parseAgentModelOutput(value).type, "final");
  for (const update of [
    { key: "depth", value: "ANSWER_B", evidence: "brief" },
    { key: "__proto__", value: "brief", evidence: "brief" },
    { key: "depth", value: "brief", evidence: "brief", permission: "reveal" },
  ])
    assert.throws(() => parseAgentModelOutput({ ...value, memoryUpdates: [update] }), /unreadable/);
  const deltas: string[] = [];
  const parser = new StreamedTutorJson((delta) => deltas.push(delta.text));
  for (const char of JSON.stringify(value)) parser.push(char);
  parser.finish();
  assert.ok(!deltas.join("").includes("PRIVATE_PREFERENCE_EVIDENCE"));
  assert.equal(deltas.join(""), final.approach + final.message + final.concept + final.nextStep);
});

test("a learner can remove a preference and explicitly replace it later", async () => {
  const id = fresh();
  const first = fixture(id);
  await runtime.runTutorAgent(first.request, first.context, {
    model: async () => ({
      ...final,
      memoryUpdates: [{ key: "depth", value: "brief", evidence: first.request.message }],
    }),
  });
  sessions.finishRun(id, first.request.requestId);
  assert.equal(store.preferences(id).length, 1);
  store.forgetMemory(id, "depth");
  assert.equal(store.preferences(id).length, 0);
  assert.equal(store.turns(id, q.sourceKey, false).length, 1);
  const second = fixture(id);
  second.request.message = "Please remember detailed explanations now.";
  await runtime.runTutorAgent(second.request, second.context, {
    model: async () => ({
      ...final,
      memoryUpdates: [{ key: "depth", value: "detailed", evidence: second.request.message }],
    }),
  });
  sessions.finishRun(id, second.request.requestId);
  assert.equal(store.preferences(id)[0].value, "detailed");
});
