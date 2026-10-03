import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TutorServiceError } from "../lib/tutor-errors";

const directory = mkdtempSync(path.join(tmpdir(), "question-coach-test-"));
process.env.EXAMS_DB_PATH = path.join(directory, "exams.db");
process.env.LEARNING_DB_PATH = path.join(directory, "learning.db");
execFileSync(process.execPath, ["scripts/seed.mjs"], { env: process.env, stdio: "pipe" });
const bank: typeof import("../lib/db") = require("../lib/db");
const practice: typeof import("../lib/practice") = require("../lib/practice");
const sessions: typeof import("../agents/ai-tutor/context/session") = require("../agents/ai-tutor/context/session");
const runtime: typeof import("../agents/ai-tutor/runtime") = require("../agents/ai-tutor/runtime");
const tools: typeof import("../agents/ai-tutor/tools") = require("../agents/ai-tutor/tools");
const route: typeof import("../app/api/practice/route") = require("../app/api/practice/route");
const tutorRoute: typeof import("../app/api/tutor/route") = require("../app/api/tutor/route");
const http: typeof import("../lib/http") = require("../lib/http");
const memory: typeof import("../agents/ai-tutor/memory/store") = require("../agents/ai-tutor/memory/store");
const questions = bank.getQuestions("architect-professional");
const single = questions.find((question) => question.type === "single_choice")!;
const multiple = questions.find((question) => question.type === "multiple_response")!;
const matching = questions.find((question) => question.type === "scenario_matching")!;
const fresh = () => sessions.ensureSession();
function saveCorrect(id: string, question = single) {
  return practice.saveDraft(
    id,
    question.id,
    bank.getAnswer(question.id)!.correctKeys,
    "Source fixture selection",
    practice.getState(id, question.id).revision,
  );
}
after(() => {
  sessions.sessionDatabase().close();
  rmSync(directory, { recursive: true, force: true });
});

test("all formats enforce exact valid selections, including unique matching items", () => {
  assert.equal(practice.validSelections(single, [], true), false);
  assert.equal(
    practice.validSelections(single, [single.options[0].key, single.options[1].key]),
    false,
  );
  assert.equal(practice.validSelections(multiple, [multiple.options[0].key], true), false);
  assert.equal(practice.validSelections(multiple, ["missing"]), false);
  assert.equal(
    practice.validSelections(matching, [
      `${matching.matchItems[0].key}:A`,
      `${matching.matchItems[0].key}:B`,
    ]),
    false,
  );
  assert.equal(
    practice.validSelections(matching, [`${matching.matchItems[0].key}:A:extra`]),
    false,
  );
  for (const question of [single, multiple, matching]) {
    const correct = bank.getAnswer(question.id)!.correctKeys;
    assert.equal(practice.validSelections(question, correct, true), true);
    assert.equal(practice.gradeAnswer([...correct].reverse(), correct), true);
    assert.equal(practice.gradeAnswer([], correct), false);
  }
});

test("submission is immutable and idempotent; repeat requests cannot reopen a hidden answer", () => {
  const id = fresh();
  const state = saveCorrect(id);
  const submitted = practice.submitAttempt(id, single.id, "submission-one", state.revision);
  assert.deepEqual(submitted.state.result, { correct: true, kind: "independent" });
  assert.equal(
    practice.submitAttempt(id, single.id, "submission-one", state.revision).state.result?.correct,
    true,
  );
  assert.equal(practice.practiceSnapshot(id, "architect-professional").progress.attempted, 1);
  assert.throws(() => practice.saveDraft(id, single.id, [], "", submitted.state.revision), /retry/);
  sessions.hide(id, single.id);
  assert.throws(
    () => practice.submitAttempt(id, single.id, "submission-one", state.revision),
    /no longer active/,
  );
  const retry = practice.retryQuestion(id, single.id, practice.getState(id, single.id).revision);
  assert.equal(retry.generation, 1);
  assert.equal(retry.exposed, true);
  const next = saveCorrect(id);
  const result = practice.submitAttempt(id, single.id, "submission-two", next.revision);
  assert.equal(result.state.result?.kind, "review");
  assert.equal(practice.practiceSnapshot(id, "architect-professional").progress.independent, 1);
  assert.equal(practice.practiceSnapshot(id, "architect-professional").progress.reviewCorrect, 1);
});

test("reveals never count as attempts, assisted success is distinct, stale drafts fail", () => {
  const id = fresh();
  practice.revealAnswer(id, single.id);
  assert.equal(practice.practiceSnapshot(id, "architect-professional").progress.attempted, 0);
  const initial = practice.getState(id, multiple.id);
  const state = saveCorrect(id, multiple);
  assert.throws(() => practice.saveDraft(id, multiple.id, [], "", initial.revision), /changed/);
  practice.recordAssistance(id, multiple.id, true);
  const result = practice.submitAttempt(id, multiple.id, "assisted-one", state.revision);
  assert.equal(result.state.result?.kind, "assisted");
  assert.equal(result.state.hintCount, 1);
  assert.equal(practice.practiceSnapshot(id, "architect-professional").progress.independent, 0);
});

test("reset and expiry cascade through stored learner data; unknown cookies are rotated", () => {
  const id = fresh();
  saveCorrect(id);
  sessions.addMessage(id, single.id, { role: "user", content: "hello" });
  sessions.beginRun(id, "reset-run");
  assert.equal(sessions.ensureSession(id), id);
  sessions.resetSession(id);
  assert.equal(http.jsonResponse({}, id).headers.get("set-cookie"), null);
  assert.notEqual(sessions.ensureSession(id), id);
  for (const table of ["messages", "question_state", "runs"])
    assert.equal(
      (
        sessions
          .sessionDatabase()
          .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE session_id = ?`)
          .get(id) as { count: number }
      ).count,
      0,
    );
  const expired = fresh();
  saveCorrect(expired);
  sessions
    .sessionDatabase()
    .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
    .run(Date.now() - sessions.retentionMs - 1, expired);
  assert.notEqual(sessions.ensureSession(expired), expired);
  assert.equal(
    (
      sessions
        .sessionDatabase()
        .prepare("SELECT COUNT(*) as count FROM question_state WHERE session_id = ?")
        .get(expired) as { count: number }
    ).count,
    0,
  );
  assert.equal(sessions.sessionDatabase().pragma("foreign_keys", { simple: true }), 1);
});

test("conversation expires independently of learning progress and is physically bounded", () => {
  const id = fresh();
  saveCorrect(id);
  for (let i = 0; i < 20; i++)
    sessions.addMessage(id, single.id, { role: "user", content: String(i) });
  assert.equal(sessions.history(id, single.id).length, 12);
  sessions
    .sessionDatabase()
    .prepare("UPDATE sessions SET touched_at = ? WHERE id = ?")
    .run(Date.now() - 3 * 60 * 60 * 1000, id);
  sessions.ensureSession(id);
  assert.equal(sessions.history(id, single.id).length, 0);
  assert.deepEqual(
    practice.getState(id, single.id).selectedKeys,
    bank.getAnswer(single.id)!.correctKeys,
  );
});

test("conversation total lifetime survives message pruning and per-question idle expiry", () => {
  const id = fresh();
  saveCorrect(id);
  sessions.addMessage(id, single.id, { role: "user", content: "old conversation" });
  sessions
    .sessionDatabase()
    .prepare("UPDATE conversation_windows SET created_at = ? WHERE session_id = ?")
    .run(Date.now() - 25 * 60 * 60 * 1000, id);
  for (let i = 0; i < 20; i++)
    sessions.addMessage(id, single.id, { role: "user", content: "recent" });
  sessions.ensureSession(id);
  assert.equal(sessions.history(id, single.id).length, 0);
  sessions.addMessage(id, single.id, { role: "user", content: "idle question" });
  sessions
    .sessionDatabase()
    .prepare(
      "UPDATE conversation_windows SET touched_at = ? WHERE session_id = ? AND question_id = ?",
    )
    .run(Date.now() - 3 * 60 * 60 * 1000, id, single.id);
  sessions.addMessage(id, multiple.id, { role: "user", content: "active question" });
  sessions.ensureSession(id);
  assert.equal(sessions.history(id, single.id).length, 0);
  assert.equal(sessions.history(id, multiple.id).length, 1);
});

test("timer keeps its original deadline; progress has no answers; recommendations stay scoped", () => {
  const id = fresh();
  practice.setPracticeSettings(id, "architect-professional", "start", true);
  const deadline = practice.practiceSnapshot(id, "architect-professional").settings.deadline;
  practice.setPracticeSettings(id, "architect-professional", "start", true);
  assert.equal(practice.practiceSnapshot(id, "architect-professional").settings.deadline, deadline);
  const correct = bank.getAnswer(single.id)!.correctKeys;
  const wrong = single.options.find((option) => !correct.includes(option.key))!.key;
  const draft = practice.saveDraft(id, single.id, [wrong], "", 0);
  practice.submitAttempt(id, single.id, "wrong-attempt", draft.revision);
  const suggested = practice.recommendations(id, multiple.id);
  assert.equal(suggested[0].sourceKey, single.sourceKey);
  assert.ok(
    suggested.length <= 3 &&
      suggested.every(
        (item) => item.id !== multiple.id && questions.some((question) => question.id === item.id),
      ),
  );
  const data = JSON.stringify(practice.practiceSnapshot(id, "architect-professional"));
  assert.ok(!data.includes('"correctKeys"') && !data.includes('"rationale"'));
});

test("restart clears all question formats and exposure, resets the timer, and starts independent scoring again", () => {
  const id = fresh();
  const slug = "architect-professional";
  practice.setPracticeSettings(id, slug, "start", true);
  for (const question of [single, multiple, matching]) {
    const draft = saveCorrect(id, question);
    practice.recordAssistance(id, question.id, true);
    practice.submitAttempt(id, question.id, `before-restart-${question.id}`, draft.revision);
  }
  practice.setPracticeSettings(id, slug, "navigate", questions.at(-1)!.sourceKey);
  sessions
    .sessionDatabase()
    .prepare("UPDATE practice_settings SET deadline = 1 WHERE session_id = ?")
    .run(id);
  const old = practice.getState(id, single.id);
  const before = Date.now();
  const snapshot = practice.restartExam(id, slug);
  assert.equal(snapshot.settings.started, true);
  assert.equal(snapshot.settings.questionKey, questions[0].sourceKey);
  assert.ok(snapshot.settings.deadline! >= before + 120 * 60_000);
  assert.ok(snapshot.settings.deadline! <= Date.now() + 120 * 60_000);
  assert.equal(snapshot.progress.attempted, 0);
  assert.equal(snapshot.result.correct, 0);
  assert.equal(snapshot.result.unanswered, 63);
  assert.deepEqual(snapshot.mistakeKeys, []);
  for (const question of [single, multiple, matching]) {
    const state = practice.getState(id, question.id);
    assert.deepEqual(state.selectedKeys, []);
    assert.equal(state.reasoning, "");
    assert.equal(state.hintCount, 0);
    assert.equal(state.visible, false);
    assert.equal(state.exposed, false);
    assert.equal(state.submitted, false);
    assert.equal(state.result, null);
  }
  assert.throws(() => practice.saveDraft(id, single.id, ["A"], "stale", old.revision), /changed/);
  assert.throws(
    () => practice.submitAttempt(id, single.id, "stale-restart-submit", old.revision),
    /changed/,
  );
  const draft = saveCorrect(id);
  const submitted = practice.submitAttempt(id, single.id, "after-restart", draft.revision);
  assert.equal(submitted.state.result?.kind, "independent");
  assert.equal(practice.practiceSnapshot(id, slug).result.correct, 1);
  practice.restartExam(id, slug);
  assert.equal(practice.practiceSnapshot(id, slug).progress.attempted, 0);
  assert.equal(sessions.ensureSession(id), id);
});

test("restart is certification and learner scoped, clears exam memory, and preserves untimed practice", () => {
  const id = fresh();
  const otherLearner = fresh();
  const otherQuestion = bank.getQuestions("architect-foundations")[0];
  const db = sessions.sessionDatabase();
  for (const [learner, question] of [
    [id, single],
    [id, otherQuestion],
    [otherLearner, single],
  ] as const) {
    const slug = practice.questionContext(question.id).certification.slug;
    practice.setPracticeSettings(learner, slug, "start", false);
    const draft = saveCorrect(learner, question);
    practice.submitAttempt(learner, question.id, `scoped-${question.id}`, draft.revision);
    sessions.addMessage(learner, question.id, {
      role: "user",
      content: "I prefer brief examples.",
    });
    memory.appendTurn({
      sessionId: learner,
      sourceKey: question.sourceKey,
      requestId: `memory-${question.id}`,
      revealed: true,
      user: "I prefer brief examples.",
      reply: { message: "Prior explanation", concept: "Concept", nextStep: "Next step" },
      tools: [],
      promptHash: "restart-test",
      updates: [
        {
          key: question.id === single.id ? "depth" : "style",
          value: question.id === single.id ? "brief" : "examples",
          evidence: "I prefer brief examples.",
        },
      ],
    });
    const turn = memory.recentTurns(learner, question.sourceKey, true, 1)[0];
    memory.writeCheckpoint({
      sessionId: learner,
      sourceKey: question.sourceKey,
      revealed: true,
      expectedVersion: 0,
      through: turn.id,
      summary: { goal: "Earlier goal", learningNotes: [], openQuestions: [], nextStep: "" },
      digest: "test",
      promptHash: "test",
      inputBytes: 200,
      outputBytes: 100,
    });
    db.prepare("INSERT INTO reveals VALUES (?, ?, ?)").run(learner, question.id, Date.now());
    db.prepare("INSERT INTO outcomes VALUES (?, ?, ?, ?, ?)").run(
      learner,
      question.id,
      slug,
      question.domainName,
      Date.now(),
    );
  }
  const otherExam = practice.practiceSnapshot(id, "architect-foundations");
  const otherProgress = practice.practiceSnapshot(otherLearner, "architect-professional");
  const snapshot = practice.restartExam(id, "architect-professional");
  assert.equal(snapshot.settings.deadline, null);
  assert.deepEqual(practice.practiceSnapshot(id, "architect-foundations"), otherExam);
  assert.deepEqual(
    practice.practiceSnapshot(otherLearner, "architect-professional"),
    otherProgress,
  );
  assert.deepEqual(memory.turns(id, single.sourceKey, true), []);
  assert.equal(memory.checkpoint(id, single.sourceKey, true), null);
  assert.equal(memory.turns(id, otherQuestion.sourceKey, true).length, 1);
  assert.equal(memory.turns(otherLearner, single.sourceKey, true).length, 1);
  assert.deepEqual(
    memory.preferences(id).map(({ key }) => key),
    ["style"],
  );
  for (const table of ["messages", "conversation_windows", "reveals", "outcomes"])
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND question_id = ?`)
          .get(id, single.id) as { n: number }
      ).n,
      0,
    );
});

test("restart API validates origin and certification and supports all four exam sets", async () => {
  const id = fresh();
  function request(certification: unknown, origin = "http://localhost") {
    return new Request("http://localhost/api/practice", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: `ai_tutor_session=${id}` },
      body: JSON.stringify({ action: "restart", certification }),
    });
  }
  assert.equal(
    (await route.POST(request("architect-professional", "https://unrelated.example"))).status,
    403,
  );
  assert.equal((await route.POST(request("missing"))).status, 404);
  assert.equal((await route.POST(request(null))).status, 404);
  for (const slug of [
    "architect-professional",
    "architect-foundations",
    "developer-foundations",
    "associate-foundations",
  ]) {
    const response = await route.POST(request(slug));
    assert.equal(response.status, 200);
    const { snapshot } = await response.json();
    assert.equal(snapshot.settings.questionKey, bank.getQuestions(slug)[0].sourceKey);
    assert.equal(snapshot.progress.attempted, 0);
    assert.ok(!JSON.stringify(snapshot).includes('"correctKeys"'));
    assert.ok(response.headers.get("set-cookie")?.includes(id));
  }
});

test("source discrepancy is retained but cannot be scored", () => {
  const flagged = bank
    .getQuestions("developer-foundations")
    .find((question) => question.reviewRequired)!;
  assert.equal(flagged.sourceKey, "developer-5.9");
  assert.ok(!flagged.reviewNote?.includes("A, D") && !flagged.reviewNote?.includes("option C"));
  assert.match(bank.getAnswer(flagged.id)!.reviewNote!, /option C/);
  const id = fresh();
  const draft = practice.saveDraft(id, flagged.id, ["A"], "", 0);
  assert.throws(
    () => practice.submitAttempt(id, flagged.id, "flagged-attempt", draft.revision),
    /source conflict/,
  );
  assert.deepEqual(practice.revealAnswer(id, flagged.id).correctKeys, ["A", "D"]);
});

function runFixture(id = fresh()) {
  const state = practice.getState(id, single.id);
  const context = tools.createContext(single.id, {
    selectedKeys: [],
    answerRevealed: state.visible,
    reasoning: "",
    hintStage: 1,
    intent: "hint",
    revision: state.revision,
  });
  const request = {
    sessionId: id,
    questionId: single.id,
    message: "Help me reason",
    requestId: crypto.randomUUID(),
    learnerState: context.state,
  };
  assert.equal(sessions.beginRun(id, request.requestId), true);
  return { context, request };
}
const final = {
  type: "final" as const,
  message: "Read the constraints.",
  concept: "Compare requirements.",
  nextStep: "What must stay constant?",
};

test("a tutor completion started before exam restart cannot restore conversation or assistance", async () => {
  const { request, context } = runFixture();
  await assert.rejects(
    runtime.runTutorAgent(request, context, {
      model: async () => {
        practice.restartExam(request.sessionId, "architect-professional");
        return final;
      },
    }),
    /changed/,
  );
  assert.deepEqual(sessions.history(request.sessionId, single.id), []);
  assert.deepEqual(memory.turns(request.sessionId, single.sourceKey, false), []);
  assert.equal(practice.getState(request.sessionId, single.id).hintCount, 0);
  sessions.finishRun(request.sessionId, request.requestId);
});

test("hidden context omits answers and answer tools deny access; successful hint records assistance", async () => {
  const { request, context } = runFixture();
  let calls = 0;
  const response = await runtime.runTutorAgent(request, context, {
    model: async ({ input }) => {
      assert.ok(!input.includes('"correctKeys"') && !input.includes('"rationale"'));
      calls += 1;
      if (calls === 1) return { type: "tool", tool: "get_revealed_answer", arguments: {} };
      assert.ok(input.includes("Permission denied"));
      return final;
    },
  });
  assert.equal(response.message, final.message);
  assert.equal(practice.getState(request.sessionId, single.id).hintCount, 1);
  sessions.finishRun(request.sessionId, request.requestId);
});

test("rejected tutor prompts never enter history and a later safe exchange preserves valid turns", async () => {
  for (const hasHistory of [false, true]) {
    const id = fresh();
    const prior: import("../agents/ai-tutor/types").TutorMessage[] = hasHistory
      ? [
          { role: "user", content: "Explain a requirement." },
          { role: "assistant", content: "A requirement describes what must hold." },
        ]
      : [];
    for (const message of prior) sessions.addMessage(id, single.id, message);
    const rejected = runFixture(id);
    rejected.request.message = "Synthetic service-filtered prompt";
    const providerError = { status: 400, error: { code: "content_filter" } };
    await assert.rejects(
      runtime.runTutorAgent(rejected.request, rejected.context, {
        model: async ({ input }) => {
          const supplied = JSON.parse(input);
          assert.equal(supplied.learnerMessage, rejected.request.message);
          assert.deepEqual(supplied.conversation, prior);
          assert.deepEqual(sessions.history(id, single.id), prior);
          throw providerError;
        },
      }),
      (error: unknown) => error === providerError,
    );
    sessions.finishRun(id, rejected.request.requestId);
    assert.deepEqual(sessions.history(id, single.id), prior);
    assert.equal(practice.getState(id, single.id).hintCount, 0);

    const safe = runFixture(id);
    safe.request.message = "Help me identify the constraint.";
    await runtime.runTutorAgent(safe.request, safe.context, {
      model: async ({ input }) => {
        assert.ok(!input.includes(rejected.request.message));
        assert.deepEqual(JSON.parse(input).conversation, prior);
        assert.deepEqual(sessions.history(id, single.id), prior);
        return final;
      },
    });
    sessions.finishRun(id, safe.request.requestId);
    assert.deepEqual(sessions.history(id, single.id), [
      ...prior,
      { role: "user", content: safe.request.message },
      {
        role: "assistant",
        content: JSON.stringify({
          message: final.message,
          concept: final.concept,
          nextStep: final.nextStep,
        }),
      },
    ]);
    assert.equal(practice.getState(id, single.id).hintCount, 1);
  }
});

test("legacy incomplete turns and a pruned leading assistant are excluded without deleting valid history", async () => {
  const id = fresh();
  const completed: import("../agents/ai-tutor/types").TutorMessage[] = [
    { role: "user", content: "A prior valid question." },
    { role: "assistant", content: "A prior valid explanation." },
  ];
  for (const message of [
    { role: "assistant" as const, content: "Pruned orphan assistant." },
    ...completed,
    { role: "user" as const, content: "Legacy service-filtered user-only request." },
  ])
    sessions.addMessage(id, single.id, message);

  for (const message of ["A safe follow-up.", "Another safe follow-up."]) {
    const { request, context } = runFixture(id);
    request.message = message;
    await runtime.runTutorAgent(request, context, {
      model: async ({ input }) => {
        assert.deepEqual(JSON.parse(input).conversation, completed);
        assert.ok(!input.includes("Legacy service-filtered user-only request."));
        assert.ok(!input.includes("Pruned orphan assistant."));
        return final;
      },
    });
    sessions.finishRun(id, request.requestId);
    completed.push(
      { role: "user", content: message },
      {
        role: "assistant",
        content: JSON.stringify({
          message: final.message,
          concept: final.concept,
          nextStep: final.nextStep,
        }),
      },
    );
  }
  const stored = sessions.history(id, single.id);
  assert.ok(
    stored.some((message) => message.content === "Legacy service-filtered user-only request."),
  );
  assert.ok(stored.some((message) => message.content === "A prior valid explanation."));
  assert.equal(practice.getState(id, single.id).hintCount, 2);
});

test("four-call tutor chain reserves its final answer and returns only named recommendation results", async () => {
  const { request, context } = runFixture();
  const sequence = [
    "get_question_context",
    "get_session_learning_context",
    "find_related_questions",
  ] as const;
  let calls = 0;
  let recommendedIds: number[] = [];
  const response = await runtime.runTutorAgent(request, context, {
    model: async ({ input, system }) => {
      const supplied = JSON.parse(input);
      assert.match(
        system,
        new RegExp(`Model calls remaining, including this call: ${4 - calls}\\.`),
      );
      assert.match(system, new RegExp(`Tool calls remaining: ${3 - calls}\\.`));
      assert.deepEqual(
        supplied.toolResults.map((entry: { tool: string }) => entry.tool),
        sequence.slice(0, calls),
      );
      assert.ok(!input.includes('"correctKeys"') && !input.includes('"rationale"'));
      if (calls < 3) return { type: "tool", tool: sequence[calls++], arguments: {} };
      calls += 1;
      assert.match(system, /final-only call/);
      const recommendations = supplied.toolResults[2].result as { id: number }[];
      recommendedIds = recommendations.map((item) => item.id);
      assert.ok(recommendedIds.length > 0);
      return {
        ...final,
        relatedQuestionIds: [single.id, ...recommendedIds, Number.MAX_SAFE_INTEGER],
      };
    },
  });
  assert.equal(calls, 4);
  assert.deepEqual(
    response.relatedQuestions.map((question) => question.id),
    recommendedIds,
  );
  assert.equal(practice.getState(request.sessionId, single.id).hintCount, 1);
  sessions.finishRun(request.sessionId, request.requestId);
});

test("a tool requested on the reserved final call is rejected without another model invocation", async () => {
  const { request, context } = runFixture();
  const sequence = [
    "get_question_context",
    "get_session_learning_context",
    "find_related_questions",
    "get_revealed_answer",
  ] as const;
  let calls = 0;
  await assert.rejects(
    runtime.runTutorAgent(request, context, {
      model: async ({ system }) => {
        if (calls === 3) assert.match(system, /final-only call/);
        return { type: "tool", tool: sequence[calls++], arguments: {} };
      },
    }),
    /response limit/,
  );
  assert.equal(calls, 4);
  assert.equal(
    sessions.history(request.sessionId, single.id).filter((message) => message.role === "assistant")
      .length,
    0,
  );
  assert.equal(practice.getState(request.sessionId, single.id).hintCount, 0);
  sessions.finishRun(request.sessionId, request.requestId);
});

test("live evaluator shares runtime budgets and final-only behavior", async () => {
  const live: typeof import("../agents/ai-tutor/harness/live") = require("../agents/ai-tutor/harness/live");
  const fixture = live.buildEvaluationCases()[0];
  const sequence = [
    "get_question_context",
    "get_session_learning_context",
    "find_related_questions",
  ] as const;
  for (const finish of [true, false]) {
    let calls = 0;
    const result = await live.runEvaluationCase(fixture, {
      model: async ({ input, system }) => {
        const supplied = JSON.parse(input);
        assert.equal(system, runtime.runtimeInstructions(4 - calls, 3 - calls));
        assert.deepEqual(
          supplied.toolResults.map((entry: { tool: string }) => entry.tool),
          sequence.slice(0, calls),
        );
        if (calls < 3) return { type: "tool", tool: sequence[calls++], arguments: {} };
        calls += 1;
        return finish ? final : { type: "tool", tool: "get_revealed_answer", arguments: {} };
      },
    });
    assert.equal(calls, 4);
    assert.equal(result.outcome, finish ? "completed" : "final_required");
    assert.equal(result.humanReview, "pending");
    if (!finish)
      assert.deepEqual(result.toolDecisions.at(-1), {
        tool: "get_revealed_answer",
        allowed: false,
        reason: "final_call_reserved",
      });
  }
});

test("a hide/reveal race prevents publishing a stale post-reveal response", async () => {
  const id = fresh();
  practice.revealAnswer(id, single.id);
  const { request, context } = runFixture(id);
  await assert.rejects(
    runtime.runTutorAgent(request, context, {
      model: async () => {
        sessions.hide(id, single.id);
        practice.revealAnswer(id, single.id);
        return final;
      },
    }),
    /changed/,
  );
  assert.equal(sessions.history(id, single.id).length, 0);
});

test("reset and navigation invalidate running explanations", async () => {
  for (const reset of [true, false]) {
    const { request, context } = runFixture();
    await assert.rejects(
      runtime.runTutorAgent(request, context, {
        model: async () => {
          if (reset) sessions.resetSession(request.sessionId);
          else
            practice.setPracticeSettings(
              request.sessionId,
              "architect-professional",
              "navigate",
              multiple.sourceKey,
            );
          return final;
        },
      }),
      /changed/,
    );
  }
});

test("harness retries only transient errors and rejects loops and wall-clock timeouts", async () => {
  let calls = 0;
  const one = runFixture();
  await runtime.runTutorAgent(one.request, one.context, {
    model: async () => {
      calls += 1;
      if (calls === 1) throw { status: 503 };
      return final;
    },
  });
  assert.equal(calls, 2);
  const two = runFixture();
  calls = 0;
  await assert.rejects(
    runtime.runTutorAgent(two.request, two.context, {
      model: async () => {
        calls += 1;
        throw { status: 401 };
      },
    }),
  );
  assert.equal(calls, 1);
  const three = runFixture();
  await assert.rejects(
    runtime.runTutorAgent(three.request, three.context, {
      model: async () => ({ type: "tool", tool: "get_question_context", arguments: {} }),
    }),
    /repeated/,
  );
  const four = runFixture();
  await assert.rejects(
    runtime.runTutorAgent(four.request, four.context, {
      timeoutMs: 15,
      model: () => new Promise(() => {}),
    }),
    (error: unknown) => error instanceof TutorServiceError && error.code === "timeout",
  );
});

test("live evaluation classifies typed provider failures without copying sensitive error messages", async () => {
  const live: typeof import("../agents/ai-tutor/harness/live") = require("../agents/ai-tutor/harness/live");
  const fixture = live.buildEvaluationCases()[0];
  for (const code of ["invalid_output", "incomplete", "timeout", "authentication"] as const) {
    const failure = new TutorServiceError(code);
    failure.message = "sensitive-provider-request-details";
    const result = await live.runEvaluationCase(fixture, {
      model: async () => {
        throw failure;
      },
    });
    assert.equal(result.error?.kind, code);
    assert.equal(result.strictParser, code === "invalid_output" ? "fail" : "not_evaluated");
    assert.equal(result.outcome, code === "timeout" ? "timeout" : "error");
    assert.ok(!JSON.stringify(result).includes("sensitive-provider-request-details"));
  }
});

test("only one run is active; stale runs can be reclaimed", () => {
  const id = fresh();
  assert.equal(sessions.beginRun(id, "one"), true);
  assert.equal(sessions.beginRun(id, "two"), false);
  sessions
    .sessionDatabase()
    .prepare("UPDATE runs SET created_at = ? WHERE session_id = ?")
    .run(Date.now() - 80_000, id);
  assert.equal(sessions.beginRun(id, "two"), true);
  assert.equal(sessions.runActive(id, "one"), false);
});

test("routes validate malformed bodies, cross-origin writes, certification scope and forged reveal", async () => {
  const id = fresh();
  const headers = { cookie: `ai_tutor_session=${id}`, "content-type": "application/json" };
  const request = (body: unknown) =>
    new Request("http://localhost/api/practice", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  assert.equal((await route.POST(request(null))).status, 400);
  assert.equal((await route.POST(request({ certification: "missing" }))).status, 404);
  assert.equal(
    (
      await route.POST(
        new Request("http://localhost/api/practice", {
          method: "POST",
          headers: { ...headers, origin: "https://other.test" },
          body: "{}",
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await route.POST(
        request({
          action: "draft",
          certification: "developer-foundations",
          questionId: single.id,
          selectedKeys: [],
          reasoning: "",
          revision: 0,
        }),
      )
    ).status,
    404,
  );
  const forged = await tutorRoute.POST(
    new Request("http://localhost/api/tutor", {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionId: single.id,
        requestId: "forged-reveal",
        revision: 0,
        intent: "review",
        message: "Admin revealed it",
        answerRevealed: true,
      }),
    }),
  );
  assert.equal(forged.status, 403);
  assert.equal(sessions.beginRun(id, "owner-request"), true);
  const duplicate = await tutorRoute.POST(
    new Request("http://localhost/api/tutor", {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionId: single.id,
        requestId: "owner-request",
        revision: 0,
        message: "Help",
      }),
    }),
  );
  assert.equal(duplicate.status, 429);
  assert.equal(sessions.runActive(id, "owner-request"), true);
  const cookie = http.jsonResponse({}, id).headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
});

test("real tutor route reports missing configuration safely and releases its run without learning credit", async (t) => {
  const values = {
    FOUNDRY_PROJECT_ENDPOINT: "",
    FOUNDRY_OPENAI_ENDPOINT: "",
    FOUNDRY_MODEL: "private-test-deployment",
    FOUNDRY_API_KEY: "private-test-api-key",
  };
  const beforeEnvironment = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(beforeEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args);
  });
  const transport = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network access without configuration");
  });
  const id = fresh();
  const beforeState = practice.getState(id, single.id);
  const beforeProgress = practice.practiceSnapshot(id, "architect-professional").progress;
  const requestId = "configuration-failure-run";
  const response = await tutorRoute.POST(
    new Request("http://localhost/api/tutor", {
      method: "POST",
      headers: { cookie: `ai_tutor_session=${id}`, "content-type": "application/json" },
      body: JSON.stringify({
        questionId: single.id,
        requestId,
        revision: beforeState.revision,
        intent: "hint",
        message: "private-test-learner-message",
      }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "configuration");
  assert.match(body.error, /setup is incomplete/);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(sessions.runActive(id, requestId), false);
  assert.deepEqual(
    sessions
      .sessionDatabase()
      .prepare("SELECT state FROM runs WHERE session_id = ? AND request_id = ?")
      .get(id, requestId),
    { state: "done" },
  );
  assert.deepEqual(practice.getState(id, single.id), beforeState);
  assert.deepEqual(
    practice.practiceSnapshot(id, "architect-professional").progress,
    beforeProgress,
  );
  assert.deepEqual(
    sessions
      .sessionDatabase()
      .prepare(
        "SELECT assisted, hint_count FROM question_state WHERE session_id = ? AND source_key = ?",
      )
      .get(id, single.sourceKey),
    { assisted: 0, hint_count: 0 },
  );
  assert.equal(
    sessions.history(id, single.id).filter((message) => message.role === "assistant").length,
    0,
  );
  assert.equal(logged.length, 1);
  assert.equal((logged[0][1] as { code: string }).code, "configuration");
  const publicOutput = JSON.stringify({ body, logged });
  for (const privateValue of [
    values.FOUNDRY_MODEL,
    values.FOUNDRY_API_KEY,
    "private-test-learner-message",
    id,
  ])
    assert.ok(!publicOutput.includes(privateValue));
  assert.equal(sessions.beginRun(id, "after-configuration-failure"), true);
  sessions.finishRun(id, "after-configuration-failure");
});

function wrongSelection(question: import("../lib/types").Question) {
  const correct = bank.getAnswer(question.id)!.correctKeys;
  if (question.type === "scenario_matching") {
    const [item, option] = correct[0].split(":");
    return [
      `${item}:${question.options.find((candidate) => candidate.key !== option)!.key}`,
      ...correct.slice(1),
    ];
  }
  return [
    question.options.find((option) => !correct.includes(option.key))!.key,
    ...correct.slice(1),
  ];
}

test("final marks include every question format across all four complete certifications", () => {
  const id = fresh();
  for (const certification of bank.getCertifications()) {
    const all = bank.getQuestions(certification.slug);
    const scorable = all.filter((question) => !question.reviewRequired);
    let expectedCorrect = 0;
    for (const [index, question] of scorable.entries()) {
      const correct = index % 3 !== 0;
      const draft = practice.saveDraft(
        id,
        question.id,
        correct ? bank.getAnswer(question.id)!.correctKeys : wrongSelection(question),
        "",
        0,
      );
      if (correct) expectedCorrect += 1;
      practice.submitAttempt(id, question.id, `complete-${question.sourceKey}`, draft.revision);
    }
    const result = practice.practiceSnapshot(id, certification.slug).result;
    assert.equal(result.correct, expectedCorrect);
    assert.equal(result.total, scorable.length);
    assert.equal(result.attempted, scorable.length);
    assert.equal(result.unanswered, 0);
    assert.deepEqual(result.unansweredKeys, []);
    assert.equal(result.percentage, Math.round((expectedCorrect / scorable.length) * 100));
    assert.equal(result.excluded, certification.slug === "developer-foundations" ? 1 : 0);
    assert.equal(
      result.domains.reduce((sum, domain) => sum + domain.correct, 0),
      expectedCorrect,
    );
    assert.equal(
      result.domains.reduce((sum, domain) => sum + domain.total, 0),
      scorable.length,
    );
    assert.equal(
      result.domains.reduce((sum, domain) => sum + domain.attempted, 0),
      scorable.length,
    );
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes("correctKeys") &&
        !serialized.includes("rationale") &&
        !serialized.includes("selected"),
    );
  }
});

test("partial results leave drafts and reveals unscored and retain first marks after retries", () => {
  const id = fresh();
  const empty = practice.practiceSnapshot(id, "architect-professional").result;
  assert.equal(empty.correct, 0);
  assert.equal(empty.percentage, 0);
  assert.equal(empty.unanswered, 63);
  saveCorrect(id, matching); // Valid but never submitted.
  practice.revealAnswer(id, multiple.id); // Explicitly unscored.
  const wrong = practice.saveDraft(id, single.id, wrongSelection(single), "", 0);
  practice.submitAttempt(id, single.id, "first-mark", wrong.revision);
  practice.retryQuestion(id, single.id, practice.getState(id, single.id).revision);
  const retry = saveCorrect(id, single);
  practice.submitAttempt(id, single.id, "retry-mark", retry.revision);
  const result = practice.practiceSnapshot(id, "architect-professional").result;
  assert.equal(result.correct, 0);
  assert.equal(result.attempted, 1);
  assert.equal(result.unanswered, 62);
  assert.ok(result.unansweredKeys.includes(matching.sourceKey));
  assert.ok(result.unansweredKeys.includes(multiple.sourceKey));
  assert.ok(!result.unansweredKeys.includes(single.sourceKey));
  assert.equal(result.independent, 1);
  assert.equal(result.review, 0); // Later retries are not added to the final mark.
  assert.deepEqual(practice.practiceSnapshot(id, "architect-professional").result, result);
  sessions.resetSession(id);
  const replacement = sessions.ensureSession(id);
  assert.equal(
    practice.practiceSnapshot(replacement, "architect-professional").result.attempted,
    0,
  );
});

test("final practice marks include assisted and previously revealed first submissions explicitly", () => {
  const id = fresh();
  const assisted = saveCorrect(id, single);
  practice.recordAssistance(id, single.id, true);
  practice.submitAttempt(id, single.id, "first-assisted", assisted.revision);
  practice.revealAnswer(id, multiple.id);
  practice.retryQuestion(id, multiple.id, practice.getState(id, multiple.id).revision);
  const review = saveCorrect(id, multiple);
  practice.submitAttempt(id, multiple.id, "first-review", review.revision);
  const result = practice.practiceSnapshot(id, "architect-professional").result;
  assert.equal(result.correct, 2);
  assert.equal(result.assisted, 1);
  assert.equal(result.review, 1);
  assert.equal(result.independent, 0);
  assert.equal(result.percentage, 3);
});

test("partial streamed hints count as assistance but cancellation saves no transcript", async () => {
  const { request, context } = runFixture();
  const controller = new AbortController();
  const events: import("../lib/tutor-stream-types").TutorRuntimeEvent[] = [];
  await assert.rejects(
    runtime.runTutorAgent({ ...request, signal: controller.signal }, context, {
      onEvent: (event) => events.push(event),
      model: async ({ onDelta }) => {
        onDelta?.({ field: "message", text: "Compare the constraints." });
        assert.equal(sessions.history(request.sessionId, single.id).length, 0);
        assert.equal(practice.getState(request.sessionId, single.id).hintCount, 0);
        controller.abort();
        return final;
      },
    }),
    /too long/,
  );
  assert.ok(events.some((event) => event.type === "delta"));
  assert.equal(sessions.history(request.sessionId, single.id).length, 0);
  const state = saveCorrect(request.sessionId);
  const submitted = practice.submitAttempt(
    request.sessionId,
    single.id,
    "partial-hint-attempt",
    state.revision,
  );
  assert.equal(submitted.state.result?.kind, "assisted");
  sessions.finishRun(request.sessionId, request.requestId);
});

test("stream rejects deltas after hide and resets partial output before retry", async () => {
  const stale = runFixture();
  const staleEvents: import("../lib/tutor-stream-types").TutorRuntimeEvent[] = [];
  await assert.rejects(
    runtime.runTutorAgent(stale.request, stale.context, {
      onEvent: (event) => staleEvents.push(event),
      model: async ({ onDelta }) => {
        sessions.hide(stale.request.sessionId, single.id);
        onDelta?.({ field: "message", text: "Stale content" });
        return final;
      },
    }),
    /changed/,
  );
  assert.ok(!staleEvents.some((event) => event.type === "delta"));
  sessions.finishRun(stale.request.sessionId, stale.request.requestId);
  const retry = runFixture();
  const events: import("../lib/tutor-stream-types").TutorRuntimeEvent[] = [];
  let calls = 0;
  await runtime.runTutorAgent(retry.request, retry.context, {
    onEvent: (event) => events.push(event),
    model: async ({ onDelta }) => {
      calls += 1;
      onDelta?.({ field: "message", text: calls === 1 ? "Partial" : final.message });
      if (calls === 1) throw Object.assign(new Error("transient"), { status: 503 });
      return final;
    },
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "delta" || event.type === "reset")
      .map((event) => event.type),
    ["delta", "reset", "delta"],
  );
  assert.equal(sessions.history(retry.request.sessionId, single.id).length, 2);
  assert.equal(practice.getState(retry.request.sessionId, single.id).hintCount, 1);
  sessions.finishRun(retry.request.sessionId, retry.request.requestId);
});

test("server SSE sends deltas before completion and releases cancelled requests once", async () => {
  const { tutorEventResponse } = await import("../lib/server-tutor-stream");
  const id = fresh();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finishCount = 0;
  let executionSignal: AbortSignal | undefined;
  const response = tutorEventResponse({
    sessionId: id,
    requestId: "stream-test",
    signal: new AbortController().signal,
    onFinish: () => {
      finishCount += 1;
    },
    execute: async (signal, emit) => {
      executionSignal = signal;
      emit({ type: "delta", field: "message", text: "First chunk" });
      await gate;
      return {
        ...final,
        relatedQuestions: [],
        runId: "stream-test",
        state: practice.getState(id, single.id),
      };
    },
  });
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /First chunk/);
  assert.equal(finishCount, 0);
  await reader.cancel();
  assert.equal(executionSignal?.aborted, true);
  assert.equal(finishCount, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finishCount, 1);
});

test("server SSE reports safe terminal errors without provider details", async () => {
  const { tutorEventResponse } = await import("../lib/server-tutor-stream");
  let finished = false;
  const response = tutorEventResponse({
    sessionId: fresh(),
    requestId: "error-stream-test",
    signal: new AbortController().signal,
    onFinish: () => {
      finished = true;
    },
    execute: async () => {
      throw new Error("private provider payload");
    },
  });
  const text = await response.text();
  assert.match(text, /"type":"error"/);
  assert.ok(!text.includes("private provider payload"));
  assert.equal(finished, true);
});
