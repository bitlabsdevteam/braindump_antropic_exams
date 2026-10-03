import type { TutorStreamEvent } from "./tutor-stream-types";

const stages = new Set([
  "question",
  "model",
  "get_question_context",
  "find_related_questions",
  "get_revealed_answer",
  "get_session_learning_context",
]);
const fields = new Set(["approach", "message", "concept", "nextStep"]);
const invalid = () => new Error("The tutor response was interrupted or invalid. Please try again.");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, limit = 8000): value is string =>
  typeof value === "string" && value.length <= limit;

function parseEvent(text: string): TutorStreamEvent {
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!record(event)) throw invalid();
  switch (event.type) {
    case "start":
      if (!shortText(event.runId, 100) || !event.runId || typeof event.answerRevealed !== "boolean")
        throw invalid();
      break;
    case "activity":
      if (
        !shortText(event.id, 100) ||
        !event.id ||
        !stages.has(String(event.stage)) ||
        !["active", "done", "denied"].includes(String(event.state))
      )
        throw invalid();
      break;
    case "delta":
      if (!fields.has(String(event.field)) || !shortText(event.text)) throw invalid();
      break;
    case "reset":
      if (event.reason !== "retry") throw invalid();
      break;
    case "error":
      if (!shortText(event.error, 1000) || !event.error || !shortText(event.code, 100))
        throw invalid();
      break;
    case "complete": {
      const reply = event.reply;
      if (
        !record(reply) ||
        !shortText(reply.runId, 100) ||
        ![reply.message, reply.concept, reply.nextStep].every(
          (value) => shortText(value) && value.trim(),
        ) ||
        (reply.approach !== undefined && !shortText(reply.approach))
      )
        throw invalid();
      const state = reply.state;
      if (
        !record(state) ||
        !Array.isArray(state.selectedKeys) ||
        state.selectedKeys.length > 100 ||
        !state.selectedKeys.every((value) => shortText(value, 100)) ||
        !shortText(state.reasoning, 1000) ||
        ![state.generation, state.revision, state.hintCount].every(
          (value) => Number.isSafeInteger(value) && Number(value) >= 0,
        ) ||
        ![state.submitted, state.exposed, state.visible].every(
          (value) => typeof value === "boolean",
        ) ||
        !(
          state.result === null ||
          (record(state.result) && typeof state.result.correct === "boolean")
        )
      )
        throw invalid();
      break;
    }
    default:
      throw invalid();
  }
  return event as TutorStreamEvent;
}

/** Read actual provider-backed SSE chunks; nothing is buffered for a typing animation. */
export async function readTutorStream(
  response: Response,
  onEvent: (event: TutorStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(
      record(body) && shortText(body.error, 1000)
        ? body.error
        : "The tutor request could not be completed.",
    );
  }
  if (
    !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
    !response.body
  )
    throw invalid();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let frames = 0;
  let runId: string | undefined;
  let terminal = false;
  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) throw invalid();
      bytes += value.byteLength;
      if (bytes > 512_000) throw invalid();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 64_000) throw invalid();
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (++frames > 20_000) throw invalid();
        const lines = frame.split(/\r?\n/);
        if (lines.every((line) => !line || line.startsWith(":"))) continue;
        if (lines.some((line) => line && !line.startsWith("data:") && !line.startsWith(":")))
          throw invalid();
        const event = parseEvent(
          lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n"),
        );
        if (event.type === "start") {
          if (runId) throw invalid();
          runId = event.runId;
        } else if (!runId && event.type !== "error") throw invalid();
        if (event.type === "complete" && event.reply.runId !== runId) throw invalid();
        onEvent(event);
        if (event.type === "complete" || event.type === "error") {
          terminal = true;
          break;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
