import test from "node:test";
import assert from "node:assert/strict";
import { readTutorStream } from "../lib/read-tutor-stream";
import type { TutorStreamEvent } from "../lib/tutor-stream-types";

const start = { type: "start", runId: "test-run", answerRevealed: false };
const complete = {
  type: "complete",
  reply: {
    runId: "test-run",
    message: "A useful hint",
    concept: "A concept",
    nextStep: "A next step",
    state: {
      selectedKeys: [],
      reasoning: "",
      generation: 0,
      revision: 0,
      hintCount: 1,
      submitted: false,
      exposed: false,
      visible: false,
      result: null,
    },
  },
};
const frame = (event: unknown) => "data: " + JSON.stringify(event) + "\n\n";
const headers = { "Content-Type": "text/event-stream" };

test("SSE reader emits fragmented Unicode deltas before completion and cancels on terminal", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const events: TutorStreamEvent[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  const running = readTutorStream(new Response(stream, { headers }), (event) => events.push(event));
  const bytes = new TextEncoder().encode(
    frame(start) + frame({ type: "delta", field: "message", text: "Café ☕" }),
  );
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
  while (events.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events[1], { type: "delta", field: "message", text: "Café ☕" });
  assert.equal(cancelled, false);
  controller.enqueue(new TextEncoder().encode(frame(complete)));
  await running;
  assert.equal(events.at(-1)?.type, "complete");
  assert.equal(cancelled, true);
});

test("SSE handles CRLF, comments, reset, and scoped errors without interpreting provider payloads", async () => {
  const payload =
    ": keepalive\r\n\r\n" +
    [
      start,
      { type: "reset", reason: "retry" },
      { type: "error", error: "Please try again.", code: "provider_unavailable" },
    ]
      .map((event) => frame(event).replace(/\n/g, "\r\n"))
      .join("");
  const events: TutorStreamEvent[] = [];
  await readTutorStream(new Response(payload, { headers }), (event) => events.push(event));
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "reset", "error"],
  );
});

test("SSE rejects malformed, truncated, oversized, out-of-order and mismatched responses", async () => {
  const cases = [
    frame(start),
    frame(start) + "data: {invalid}\n\n",
    frame({ type: "delta", field: "message", text: "premature" }),
    frame(start) + frame(start),
    frame(start) + frame({ type: "delta", field: "reasoning", text: "private" }),
    frame(start) + frame({ type: "delta", field: "message", text: "a".repeat(8001) }),
    frame(start) + frame({ ...complete, reply: { ...complete.reply, runId: "other-run" } }),
    frame(start) + frame({ ...complete, reply: { ...complete.reply, state: {} } }),
    frame(start) + "a".repeat(64_001),
  ];
  for (const payload of cases) {
    await assert.rejects(
      readTutorStream(new Response(payload, { headers }), () => {}),
      /interrupted or invalid/,
    );
  }
  await assert.rejects(
    readTutorStream(new Response(JSON.stringify(complete)), () => {}),
    /interrupted or invalid/,
  );
});

test("SSE cancels when consumer rejects an error or stale response", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame(start)));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readTutorStream(new Response(body, { headers }), () => {
      throw new Error("stale");
    }),
    /stale/,
  );
  assert.equal(cancelled, true);
});

test("JSON preflight failures preserve the safe server message", async () => {
  await assert.rejects(
    readTutorStream(
      new Response(JSON.stringify({ error: "Tutor setup is incomplete." }), { status: 503 }),
      () => {},
    ),
    /setup is incomplete/,
  );
});

test("abort cancels an idle stream reader without waiting for another provider chunk", async () => {
  let cancelled = false;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame(start)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const running = readTutorStream(new Response(body, { headers }), () => {}, abort.signal);
  abort.abort();
  await assert.rejects(running, /interrupted or invalid/);
  assert.equal(cancelled, true);
});
