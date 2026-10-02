import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TraceEvent } from "../types";

export type RunTrace = {
  runId: string;
  promptHash: string;
  startedAt: string;
  endedAt?: string;
  outcome?: string;
  events: TraceEvent[];
};
export function startTrace(promptHash: string): RunTrace {
  return {
    runId: crypto.randomUUID(),
    promptHash,
    startedAt: new Date().toISOString(),
    events: [],
  };
}
export function traceEvent(trace: RunTrace, event: string, data?: Record<string, unknown>) {
  trace.events.push({ at: new Date().toISOString(), event, data });
}
export function finishTrace(trace: RunTrace, outcome: string) {
  trace.endedAt = new Date().toISOString();
  trace.outcome = outcome;
  if (process.env.TUTOR_TRACE !== "1") return;
  const directory = path.join(process.cwd(), "data", "tutor-traces");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${trace.runId}.json`), JSON.stringify(trace, null, 2));
}
