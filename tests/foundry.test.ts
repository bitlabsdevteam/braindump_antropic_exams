import assert from "node:assert/strict";
import test from "node:test";
import { DefaultAzureCredential } from "@azure/identity";
import OpenAI from "openai";
import {
  agentSchema,
  askTutorAgent,
  foundryConfiguration,
  isTransientFoundryError,
  parseAgentModelOutput,
  type AgentModelOutput,
} from "../lib/foundry";
import { TutorServiceError, tutorFailure } from "../lib/tutor-errors";
import { buildEvaluationCases, runEvaluationCase } from "../agents/ai-tutor/harness/live";

const finalWire = {
  type: "final",
  tool: null,
  arguments: null,
  approach: "Identify the requirement and compare the stated constraints.",
  message: "Read the requirement.",
  concept: "Data freshness",
  nextStep: "Identify the constraint.",
  relatedQuestionIds: [],
};
const toolWire = {
  type: "tool",
  tool: "get_question_context",
  arguments: { limit: null, domainNumber: null },
  approach: null,
  message: null,
  concept: null,
  nextStep: null,
  relatedQuestionIds: null,
};
const final: AgentModelOutput = {
  type: "final",
  approach: "Identify the requirement and compare the stated constraints.",
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
      FOUNDRY_OPENAI_ENDPOINT: undefined,
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

test("Foundry resource endpoints support explicit key or Entra auth without ambiguous fallback", () => {
  withEnvironment(
    {
      FOUNDRY_PROJECT_ENDPOINT: undefined,
      FOUNDRY_OPENAI_ENDPOINT: "https://example.openai.azure.com/openai/v1/",
      FOUNDRY_MODEL: "tutor-deployment",
      FOUNDRY_CREDENTIAL: "api_key",
      FOUNDRY_API_KEY: "test-secret",
      FOUNDRY_MAX_OUTPUT_TOKENS: "4096",
    },
    () => {
      assert.equal(foundryConfiguration().mode, "resource");
      assert.equal(foundryConfiguration().credential, "api_key");
      assert.equal(foundryConfiguration().endpoint, "https://example.openai.azure.com/openai/v1");
      assert.equal(JSON.stringify(foundryConfiguration()).includes("test-secret"), false);
      withEnvironment({ FOUNDRY_CREDENTIAL: undefined }, () =>
        assert.equal(foundryConfiguration().credential, "api_key"),
      );
      withEnvironment({ FOUNDRY_CREDENTIAL: "default" }, () =>
        assert.equal(foundryConfiguration().credential, "default"),
      );
      withEnvironment(
        { FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/tutor" },
        () => assert.throws(foundryConfiguration),
      );
      withEnvironment({ FOUNDRY_API_KEY: "" }, () => assert.throws(foundryConfiguration));
      for (const value of ["511", "16385", "NaN", "2000.5"])
        withEnvironment({ FOUNDRY_MAX_OUTPUT_TOKENS: value }, () =>
          assert.throws(foundryConfiguration),
        );
      for (const value of [
        "http://example.com/openai/v1",
        "https://example.com/api/projects/tutor",
        "https://example.com/openai/v1?key=secret",
      ])
        withEnvironment({ FOUNDRY_OPENAI_ENDPOINT: value }, () =>
          assert.throws(foundryConfiguration),
        );
    },
  );
});

test("resource SDK sends bounded strict Responses requests to Azure and preserves provider failures", async (t) => {
  const values = {
    FOUNDRY_PROJECT_ENDPOINT: "",
    FOUNDRY_OPENAI_ENDPOINT: "https://sdk-test.openai.azure.com/openai/v1",
    FOUNDRY_MODEL: "test-deployment",
    FOUNDRY_API_KEY: "test-only-key",
    FOUNDRY_CREDENTIAL: "api_key",
    FOUNDRY_MAX_OUTPUT_TOKENS: "4096",
  };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let calls = 0;
  let status = 200;
  let completed = true;
  let output = finalWire;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://sdk-test.openai.azure.com/openai/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test-deployment");
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 4096);
    assert.deepEqual(body.text.format.schema, agentSchema);
    assert.equal(body.text.format.strict, true);
    return Response.json(
      status === 200
        ? {
            id: "response-test",
            object: "response",
            status: completed ? "completed" : "incomplete",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
              },
            ],
            usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
          }
        : { error: { message: "private provider detail test-only-key", code: "server_error" } },
      { status },
    );
  });
  let usage;
  const result = await askTutorAgent({
    system: "test",
    input: "test",
    onUsage: (value) => {
      usage = value;
    },
  });
  assert.equal(result.type, "final");
  assert.deepEqual(usage, { inputTokens: 7, outputTokens: 5, totalTokens: 12 });
  completed = false;
  await assert.rejects(
    askTutorAgent({ system: "test", input: "test" }),
    (e: unknown) => e instanceof TutorServiceError && e.code === "incomplete",
  );
  completed = true;
  output = { ...finalWire, message: "" };
  await assert.rejects(
    askTutorAgent({ system: "test", input: "test" }),
    (e: unknown) => e instanceof TutorServiceError && e.code === "invalid_output",
  );
  for (const failure of [401, 403, 404, 429, 500]) {
    status = failure;
    const beforeCalls = calls;
    await assert.rejects(askTutorAgent({ system: "test", input: "test" }), (e: unknown) => {
      assert.equal((e as { status: number }).status, failure);
      assert.equal(JSON.stringify(tutorFailure(e)).includes("test-only-key"), false);
      return true;
    });
    assert.equal(calls, beforeCalls + 1, "SDK must not add retries outside the harness");
  }
});

test("project SDK uses the project Responses endpoint and Entra audience and parses structured output", async (t) => {
  const values = {
    FOUNDRY_PROJECT_ENDPOINT: "https://project-sdk-test.services.ai.azure.com/api/projects/tutor",
    FOUNDRY_OPENAI_ENDPOINT: "",
    FOUNDRY_MODEL: "project-test-deployment",
    FOUNDRY_CREDENTIAL: "default",
    FOUNDRY_API_KEY: "unused-project-test-key",
    FOUNDRY_MAX_OUTPUT_TOKENS: "4096",
  };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const credential = t.mock.method(
    DefaultAzureCredential.prototype,
    "getToken",
    async (scopes: string | string[]) => {
      assert.deepEqual(Array.isArray(scopes) ? scopes : [scopes], [
        "https://ai.azure.com/.default",
      ]);
      return { token: "synthetic-project-token", expiresOnTimestamp: Date.now() + 600_000 };
    },
  );
  const transport = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(
        request.url,
        "https://project-sdk-test.services.ai.azure.com/api/projects/tutor/openai/v1/responses",
      );
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-project-token");
      assert.equal(request.headers.has("api-key"), false);
      const body = await request.json();
      assert.equal(body.model, "project-test-deployment");
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 4096);
      assert.equal(body.text.format.strict, true);
      assert.deepEqual(body.text.format.schema, agentSchema);
      return Response.json({
        id: "project-response-test",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(finalWire), annotations: [] }],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      });
    },
  );
  let usage;
  const result = await askTutorAgent({
    system: "Synthetic project test",
    input: "Synthetic input",
    onUsage: (value) => {
      usage = value;
    },
  });
  assert.deepEqual(result, { ...final, relatedQuestionIds: [] });
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.equal(credential.mock.callCount(), 1);
  assert.equal(transport.mock.callCount(), 1);
});

test("tutor diagnostics distinguish actionable failures without exposing raw provider data", () => {
  for (const [error, code] of [
    [new TutorServiceError("configuration"), "configuration"],
    [{ name: "AggregateAuthenticationError", message: "secret" }, "authentication"],
    [{ status: 401, message: "secret" }, "authentication"],
    [{ status: 403, message: "secret" }, "authentication"],
    [{ status: 404, message: "secret" }, "deployment"],
    [{ status: 400, message: "secret" }, "request"],
    [{ status: 400, code: "content_filter", message: "secret" }, "content_filter"],
    [{ status: 429, message: "secret" }, "rate_limit"],
    [{ name: "TimeoutError", message: "secret" }, "timeout"],
    [new Error("secret"), "unavailable"],
  ] as const) {
    assert.equal(tutorFailure(error).code, code);
    assert.equal(JSON.stringify(tutorFailure(error)).includes("secret"), false);
  }
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
    { ...finalWire, approach: null },
    { ...finalWire, approach: " " },
    { ...finalWire, approach: "x".repeat(1001) },
    { ...finalWire, message: "x".repeat(8001) },
    { ...finalWire, relatedQuestionIds: [0] },
    { ...finalWire, relatedQuestionIds: [1.5] },
    { ...finalWire, relatedQuestionIds: [1, 2, 3, 4, 5, 6] },
  ])
    assert.throws(() => parseAgentModelOutput(invalid));
});

test("only transient failures qualify for harness retries", () => {
  // Real SDK subclasses keep name="Error"; mocks with a custom name missed this.
  for (const error of [
    new OpenAI.APIConnectionError({}),
    new OpenAI.APIConnectionTimeoutError({}),
  ]) {
    assert.equal(error.name, "Error");
    assert.equal(isTransientFoundryError(error), true);
  }
  assert.equal(tutorFailure(new OpenAI.APIConnectionTimeoutError({})).code, "timeout");
  assert.equal(isTransientFoundryError(new OpenAI.APIUserAbortError({})), false);
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
    Array.from({ length: 32 }, (_, index) => index + 1),
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
    cases.slice(28, 31).map((item) => item.fixture.learnerState.hintStage),
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
