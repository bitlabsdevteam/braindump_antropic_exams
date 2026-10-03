import { NextResponse } from "next/server";
import { withLearnerCookie } from "./http";
import { PracticeError } from "./practice";
import { TutorServiceError, tutorFailure } from "./tutor-errors";
import type { TutorRuntimeEvent, TutorStreamEvent, TutorStreamReply } from "./tutor-stream-types";

export function tutorEventResponse({
  sessionId,
  requestId,
  signal,
  execute,
  onFinish,
}: {
  sessionId: string;
  requestId: string;
  signal: AbortSignal;
  execute: (
    signal: AbortSignal,
    emit: (event: TutorRuntimeEvent) => void,
  ) => Promise<TutorStreamReply>;
  onFinish: () => void;
}) {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    signal.removeEventListener("abort", disconnect);
    onFinish();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    controller.close();
  };
  const disconnect = () => {
    abort.abort();
    close();
    finish();
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        signal.addEventListener("abort", disconnect, { once: true });
        if (signal.aborted) {
          disconnect();
          return;
        }
        const emit = (event: TutorStreamEvent) => {
          if (closed || abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          // The synchronous SDK callback cannot await a slow browser. Bound its queue.
          if ((controller.desiredSize ?? 0) < -1_048_576) {
            abort.abort();
            throw new TutorServiceError("unavailable");
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        heartbeat = setInterval(() => {
          if (!closed && !abort.signal.aborted && (controller.desiredSize ?? 0) > 0)
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 10_000);
        void (async () => {
          try {
            const reply = await execute(abort.signal, emit);
            emit({ type: "complete", reply });
          } catch (error) {
            if (!closed && !abort.signal.aborted) {
              const failure = tutorFailure(error);
              if (!(error instanceof PracticeError))
                console.error("[ai-tutor]", {
                  requestId,
                  code: failure.code,
                  status: failure.status,
                  action: failure.action,
                });
              try {
                emit({
                  type: "error",
                  error: error instanceof PracticeError ? error.message : failure.message,
                  code: error instanceof PracticeError ? "question_changed" : failure.code,
                });
              } catch {
                // A disconnected or stalled reader cannot receive a terminal frame.
                abort.abort();
              }
            }
          } finally {
            close();
            finish();
          }
        })();
      },
      cancel() {
        // cancel() is called after the reader has closed the stream; do not close it twice.
        closed = true;
        abort.abort();
        finish();
      },
    },
    { highWaterMark: 65_536, size: (chunk) => chunk.byteLength },
  );
  return withLearnerCookie(
    new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    }),
    sessionId,
  );
}
