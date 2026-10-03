import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { askTutorAgent, parseAgentModelOutput, type TutorTextDelta } from "../lib/foundry";
import { StreamedTutorJson } from "../lib/streamed-tutor-json";
import { TutorServiceError } from "../lib/tutor-errors";

const final = {
  type: "final",
  tool: null,
  arguments: null,
  approach: "Consider the stated requirement.",
  message: "Read each constraint.",
  concept: "Requirements",
  nextStep: "Which constraint matters?",
  relatedQuestionIds: [],
};
const tool = {
  type: "tool",
  tool: "get_question_context",
  arguments: { limit: null, domainNumber: null },
  approach: null,
  message: null,
  concept: null,
  nextStep: null,
  relatedQuestionIds: null,
};
const encoder = new TextEncoder();
const encode = (event: Record<string, unknown>) =>
  encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const delta = (text: string) => ({
  type: "response.output_text.delta",
  delta: text,
  output_index: 0,
  content_index: 0,
  item_id: "message-1",
  sequence_number: 1,
});
function terminal(raw: string, status = "completed") {
  return {
    type: `response.${status}`,
    response: {
      id: "response-1",
      object: "response",
      status,
      output: [
        {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: raw, annotations: [] }],
        },
      ],
      usage: { input_tokens: 11, output_tokens: 9, total_tokens: 20 },
    },
  };
}
function accumulated(events: TutorTextDelta[]) {
  return Object.fromEntries(
    ["approach", "message", "concept", "nextStep"].map((field) => [
      field,
      events
        .filter((event) => event.field === field)
        .map((event) => event.text)
        .join(""),
    ]),
  );
}
function setup(t: TestContext, transport: (body: Record<string, unknown>) => Response) {
  const values = {
    FOUNDRY_PROJECT_ENDPOINT: "",
    FOUNDRY_OPENAI_ENDPOINT: "https://stream-test.openai.azure.com/openai/v1",
    FOUNDRY_CREDENTIAL: "api_key",
    FOUNDRY_API_KEY: "synthetic-stream-key",
    FOUNDRY_MODEL: "synthetic-stream",
    FOUNDRY_MAX_OUTPUT_TOKENS: "4096",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(request.url, "https://stream-test.openai.azure.com/openai/v1/responses");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-stream-key");
      const body = await request.json();
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      return transport(body);
    },
  );
}
function sse(events: Record<string, unknown>[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encode(event));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

// All split positions include escape sequences, literal UTF-16 surrogate boundaries,
// and property boundaries; completed parsing must agree with the real wire object.
test("incremental learner fields survive every Unicode, escape and JSON chunk boundary", () => {
  const value = {
    ...final,
    approach: "日本語 😀",
    message: 'Quotes " / slash \\ newline\n\t and 😀',
    concept: "A\rB",
    nextStep: "Check ✓",
  };
  const raw = JSON.stringify(value)
    .replace("日本語", "\\u65e5\\u672c\\u8a9e")
    .replace("😀", "\\ud83d\\ude00");
  const expected = {
    approach: value.approach,
    message: value.message,
    concept: value.concept,
    nextStep: value.nextStep,
  };
  for (let index = 0; index <= raw.length; index++) {
    const events: TutorTextDelta[] = [];
    const parser = new StreamedTutorJson((event) => events.push(event));
    parser.push(raw.slice(0, index));
    parser.push(raw.slice(index));
    assert.deepEqual(parser.finish(), value);
    assert.deepEqual(accumulated(events), expected);
  }
  const events: TutorTextDelta[] = [];
  const parser = new StreamedTutorJson((event) => events.push(event));
  for (let index = 0; index < raw.length; index++) parser.push(raw[index]);
  assert.deepEqual(parser.finish(), value);
  assert.deepEqual(accumulated(events), expected);
  for (const event of events)
    assert.ok(!/[\uD800-\uDBFF]$/.test(event.text) && !/^[\uDC00-\uDFFF]/.test(event.text));
});

test("extractor waits for final discriminator and never publishes tool or nested fields", () => {
  const events: TutorTextDelta[] = [];
  const parser = new StreamedTutorJson((event) => events.push(event));
  parser.push('{"approach":"A criterion","message":"A hint","type":"final","tool":null,');
  assert.deepEqual(events, []);
  parser.push(
    '"arguments":null,"concept":"A concept","nextStep":"A check","relatedQuestionIds":[]}',
  );
  assert.equal((parser.finish() as { type: string }).type, "final");
  assert.deepEqual(accumulated(events), {
    approach: "A criterion",
    message: "A hint",
    concept: "A concept",
    nextStep: "A check",
  });
  const toolEvents: TutorTextDelta[] = [];
  const toolParser = new StreamedTutorJson((event) => toolEvents.push(event));
  toolParser.push(
    JSON.stringify({
      ...tool,
      arguments: { nested: { message: "private tool text", approach: "private reasoning" } },
    }),
  );
  toolParser.finish();
  assert.deepEqual(toolEvents, []);
});

test("extractor rejects duplicate fields, malformed escapes, truncation and bounds", () => {
  for (const raw of [
    '{"type":"final","type":"tool"}',
    '{"type":"final","tool":null,"arguments":null,"message":"bad\\x"}',
    '{"type":"final",}',
    '{"type":"final"} trailing',
    '{"type":"final","tool":null,"arguments":null,"approach":"' + "x".repeat(1001),
    '{"type":"final","tool":null,"arguments":null,"message":"' + "x".repeat(8001),
    " ".repeat(32001),
  ])
    assert.throws(
      () => new StreamedTutorJson(() => {}).push(raw),
      (error: unknown) => error instanceof TutorServiceError && error.code === "invalid_output",
    );
  const incomplete = new StreamedTutorJson(() => {});
  incomplete.push('{"type":"final","tool":null,"arguments":null,"message":"unfinished');
  assert.throws(() => incomplete.finish());
});

test("real SDK SSE emits allowed text before completion and ignores provider reasoning events", async (t) => {
  let transportController: ReadableStreamDefaultController<Uint8Array>;
  let complete = false;
  const raw = JSON.stringify(final);
  const boundary = raw.indexOf("stated");
  const transport = setup(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            transportController = controller;
            controller.enqueue(
              encode({ type: "response.reasoning_text.delta", delta: "PRIVATE REASONING" }),
            );
            controller.enqueue(
              encode({
                type: "response.function_call_arguments.delta",
                delta: "PRIVATE TOOL JSON",
              }),
            );
            controller.enqueue(encode(delta(raw.slice(0, boundary))));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const events: TutorTextDelta[] = [];
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let usage;
  const resultPromise = askTutorAgent({
    system: "synthetic",
    input: "synthetic",
    onUsage: (value) => {
      usage = value;
    },
    onDelta: (event) => {
      events.push(event);
      if (events.length === 1) {
        assert.equal(complete, false);
        resolveFirst();
      }
    },
  });
  const timer = setTimeout(() => resolveFirst(), 2000);
  await first;
  clearTimeout(timer);
  assert.ok(events.length > 0, "a real partial delta must arrive before the terminal response");
  complete = true;
  transportController!.enqueue(encode(delta(raw.slice(boundary))));
  transportController!.enqueue(encode(terminal(raw)));
  transportController!.close();
  const result = await resultPromise;
  assert.deepEqual(result, parseAgentModelOutput(final));
  assert.deepEqual(accumulated(events), {
    approach: final.approach,
    message: final.message,
    concept: final.concept,
    nextStep: final.nextStep,
  });
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 9, totalTokens: 20 });
  assert.equal(transport.mock.callCount(), 1);
});

test("streamed tool JSON is parsed without any learner deltas", async (t) => {
  const raw = JSON.stringify(tool);
  setup(t, () => sse([delta(raw), terminal(raw)]));
  const events: TutorTextDelta[] = [];
  assert.deepEqual(
    await askTutorAgent({ system: "test", input: "test", onDelta: (event) => events.push(event) }),
    { type: "tool", tool: "get_question_context", arguments: {} },
  );
  assert.deepEqual(events, []);
});

test("stream errors, incomplete responses, refusal, malformed JSON and inconsistent terminal text fail safely", async (t) => {
  const raw = JSON.stringify(final);
  let events: Record<string, unknown>[] = [];
  setup(t, () => sse(events));
  const scenarios: [Record<string, unknown>[], string][] = [
    [[delta(raw.slice(0, -1))], "incomplete"],
    [[delta(raw), terminal(raw, "incomplete")], "incomplete"],
    [
      [
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code: "server_error", message: "PRIVATE service detail" },
          },
        },
      ],
      "unavailable",
    ],
    [
      [
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
        },
      ],
      "content_filter",
    ],
    [
      [
        {
          type: "error",
          code: "content_filter",
          message: "PRIVATE provider refusal",
          sequence_number: 1,
        },
      ],
      "content_filter",
    ],
    [
      [{ type: "response.refusal.delta", delta: "PRIVATE refusal text" }, terminal("")],
      "content_filter",
    ],
    [[delta("{malformed"), terminal("{malformed")], "invalid_output"],
    [[delta(raw), terminal(raw.replace("Requirements", "Different"))], "invalid_output"],
    [
      [
        delta(JSON.stringify({ ...final, approach: "" })),
        terminal(JSON.stringify({ ...final, approach: "" })),
      ],
      "invalid_output",
    ],
  ];
  for (const [sequence, expected] of scenarios) {
    events = sequence;
    const emitted: TutorTextDelta[] = [];
    await assert.rejects(
      askTutorAgent({ system: "test", input: "test", onDelta: (event) => emitted.push(event) }),
      (error: unknown) => error instanceof TutorServiceError && error.code === expected,
    );
    assert.ok(!JSON.stringify(emitted).includes("PRIVATE"));
  }
});

test("aborting live transport prevents later learner deltas and completion", async (t) => {
  const controller = new AbortController();
  const raw = JSON.stringify(final);
  setup(t, () =>
    sse([
      delta(raw.slice(0, raw.indexOf("stated"))),
      delta(raw.slice(raw.indexOf("stated"))),
      terminal(raw),
    ]),
  );
  const events: TutorTextDelta[] = [];
  await assert.rejects(
    askTutorAgent({
      system: "test",
      input: "test",
      signal: controller.signal,
      onDelta: (event) => {
        events.push(event);
        controller.abort();
      },
    }),
    (error: unknown) => error instanceof TutorServiceError && error.code === "timeout",
  );
  assert.equal(events.length, 1);
});

test("an already cancelled streaming request makes no network call or learner callback", async (t) => {
  const transport = setup(t, () => sse([]));
  const controller = new AbortController();
  controller.abort();
  let deltas = 0;
  await assert.rejects(
    askTutorAgent({
      system: "test",
      input: "test",
      signal: controller.signal,
      onDelta: () => {
        deltas += 1;
      },
    }),
    (error: unknown) => error instanceof TutorServiceError && error.code === "timeout",
  );
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(deltas, 0);
});
