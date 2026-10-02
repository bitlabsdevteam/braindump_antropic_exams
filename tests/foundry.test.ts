import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSchema,
  foundryConfiguration,
  isTransientFoundryError,
  parseAgentModelOutput,
  type AgentModelOutput,
} from "../lib/foundry";
import { buildEvaluationCases, runEvaluationCase } from "../agents/ai-tutor/harness/live";

const finalWire = {
  type: "final",
  tool: null,
  arguments: null,
  message: "Read the requirement.",
  concept: "Data freshness",
  nextStep: "Identify the constraint.",
  relatedQuestionIds: [],
};
const toolWire = {
  type: "tool",
  tool: "get_question_context",
  arguments: { limit: null, domainNumber: null },
  message: null,
  concept: null,
  nextStep: null,
  relatedQuestionIds: null,
};
const final: AgentModelOutput = {
  type: "final",
  message: "Read the requirement.",
  concept: "Data freshness",
  nextStep: "Identify the constraint.",
};

function withEnvironment(values: Record<string, string | undefined>, callback: () => void) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    callback();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Foundry uses valid project configuration and deterministic credential defaults", () => {
  withEnvironment(
    {
      FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/tutor/",
      FOUNDRY_MODEL: "tutor-deployment",
      FOUNDRY_CREDENTIAL: undefined,
      NODE_ENV: "development",
    },
    () => {
      assert.equal(
        foundryConfiguration().endpoint,
        "https://example.services.ai.azure.com/api/projects/tutor",
      );
      assert.equal(foundryConfiguration().credential, "default");
      withEnvironment({ NODE_ENV: "production" }, () =>
        assert.equal(foundryConfiguration().credential, "managed_identity"),
      );
      withEnvironment({ NODE_ENV: "production", FOUNDRY_CREDENTIAL: "default" }, () =>
        assert.equal(foundryConfiguration().credential, "default"),
      );
      for (const endpoint of [
        undefined,
        "invalid",
        "http://example.com/api/projects/tutor",
        "https://example.com/openai/v1",
        "https://user:secret@example.com/api/projects/tutor",
        "https://example.com/api/projects/tutor?secret=x",
      ]) {
        withEnvironment({ FOUNDRY_PROJECT_ENDPOINT: endpoint }, () =>
          assert.throws(foundryConfiguration),
        );
      }
      for (const model of [undefined, "", "bad/model", "a".repeat(257)])
        withEnvironment({ FOUNDRY_MODEL: model }, () => assert.throws(foundryConfiguration));
      withEnvironment({ FOUNDRY_CREDENTIAL: "api_key" }, () => assert.throws(foundryConfiguration));
    },
  );
});

test("strict schema recursively rejects open-ended objects and requires declared fields", () => {
  function check(schema: Record<string, unknown>) {
    if (
      schema.type === "object" ||
      (Array.isArray(schema.type) && schema.type.includes("object"))
    ) {
      assert.equal(schema.additionalProperties, false);
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      assert.deepEqual([...(schema.required as string[])].sort(), Object.keys(properties).sort());
      Object.values(properties).forEach(check);
    }
  }
  check(agentSchema);
});

test("model parser accepts scoped actions and rejects arbitrary tool arguments and malformed output", () => {
  assert.equal(parseAgentModelOutput(finalWire).type, "final");
  const tool = parseAgentModelOutput(toolWire);
  assert.equal(tool.type, "tool");
  if (tool.type === "tool") assert.deepEqual(tool.arguments, {});
  const related = parseAgentModelOutput({
    ...toolWire,
    tool: "find_related_questions",
    arguments: { limit: 3, domainNumber: 2 },
  });
  if (related.type === "tool") assert.deepEqual(related.arguments, { limit: 3, domainNumber: 2 });
  for (const invalid of [
    null,
    [],
    {},
    { ...toolWire, tool: "run_shell" },
    { ...toolWire, arguments: [] },
    { ...toolWire, arguments: {} },
    { ...toolWire, arguments: { limit: null, domainNumber: null, questionId: 1 } },
    { ...toolWire, arguments: { limit: 1, domainNumber: null } },
    { ...toolWire, tool: "find_related_questions", arguments: { limit: 6, domainNumber: null } },
    { ...toolWire, tool: "find_related_questions", arguments: { limit: 1, domainNumber: -1 } },
    { ...toolWire, message: "mixed action" },
    { ...finalWire, tool: "get_question_context" },
    { ...finalWire, extra: true },
    { ...finalWire, message: " " },
    { ...finalWire, message: "x".repeat(8001) },
    { ...finalWire, relatedQuestionIds: [0] },
    { ...finalWire, relatedQuestionIds: [1.5] },
    { ...finalWire, relatedQuestionIds: [1, 2, 3, 4, 5, 6] },
  ])
    assert.throws(() => parseAgentModelOutput(invalid));
});

test("only transient failures qualify for harness retries", () => {
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal(isTransientFoundryError({ status }), true);
  for (const status of [400, 401, 403, 404, 422])
    assert.equal(isTransientFoundryError({ status }), false);
  assert.equal(isTransientFoundryError({ name: "APIConnectionError" }), true);
  assert.equal(isTransientFoundryError({ name: "APIConnectionTimeoutError" }), true);
  assert.equal(isTransientFoundryError({ code: "ECONNRESET" }), true);
  for (const error of [
    new SyntaxError("invalid"),
    new Error("missing config"),
    { name: "AbortError" },
    null,
  ])
    assert.equal(isTransientFoundryError(error), false);
});

test("evaluation fixtures cover all documented cases and withhold hidden mappings", () => {
  const cases = buildEvaluationCases();
  assert.deepEqual(
    cases.map((item) => item.id),
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  for (const item of cases) {
    assert.ok(item.expectedBehavior && item.failureConditions && item.fixture.learnerMessage);
    assert.equal(JSON.stringify(item.fixture).includes("correctKeys"), false);
    assert.equal(JSON.stringify(item.fixture).includes('"rationale"'), false);
    if (!item.fixture.learnerState.answerRevealed) assert.equal(item.revealedSource, null);
  }
  assert.equal(cases[7].fixture.activeQuestion?.type, "multiple_response");
  assert.equal(cases[10].fixture.activeQuestion?.type, "scenario_matching");
  assert.equal(cases[23].fixture.activeQuestion, null);
  assert.deepEqual(
    cases.slice(28).map((item) => item.fixture.learnerState.hintStage),
    [1, 2, 3],
  );
});

test("live harness denies hidden answer tools and never claims behavioral pass", async () => {
  let calls = 0;
  const report = await runEvaluationCase(buildEvaluationCases()[0], {
    model: async ({ input }) => {
      const context = JSON.parse(input);
      assert.equal(input.includes("correctKeys"), false);
      if (++calls === 1) return { type: "tool", tool: "get_revealed_answer", arguments: {} };
      assert.equal(context.toolResults[0].result.error, "Permission denied");
      return final;
    },
  });
  assert.equal(report.outcome, "completed");
  assert.equal(report.strictParser, "pass");
  assert.equal(report.toolDecisions[0].allowed, false);
  assert.equal(report.humanReview, "pending");
});

test("live harness supplies revealed synthetic rationale only after scoped tool request", async () => {
  let calls = 0;
  const report = await runEvaluationCase(buildEvaluationCases()[5], {
    model: async ({ input }) => {
      const context = JSON.parse(input);
      if (++calls === 1) {
        assert.equal(input.includes("correctKeys"), false);
        return { type: "tool", tool: "get_revealed_answer", arguments: {} };
      }
      assert.deepEqual(context.toolResults[0].result.correctKeys, ["B"]);
      assert.ok(context.toolResults[0].result.rationale);
      return final;
    },
  });
  assert.equal(report.outcome, "completed");
  assert.equal(report.toolDecisions[0].allowed, true);
});

test("live evaluation terminates repeated tools, invalid output, and unresponsive providers", async () => {
  const fixture = buildEvaluationCases()[0];
  const repeat = await runEvaluationCase(fixture, {
    model: async () => ({ type: "tool", tool: "get_question_context", arguments: {} }),
  });
  assert.equal(repeat.outcome, "repeated_tool");
  const invalid = await runEvaluationCase(fixture, {
    model: async () => {
      throw new Error("Foundry returned an invalid agent decision");
    },
  });
  assert.equal(invalid.strictParser, "fail");
  assert.equal(invalid.error?.kind, "invalid_output");
  const timeout = await runEvaluationCase(fixture, {
    timeoutMs: 5,
    model: async () => new Promise<AgentModelOutput>(() => {}),
  });
  assert.equal(timeout.outcome, "timeout");
  assert.equal(timeout.strictParser, "not_evaluated");
});
