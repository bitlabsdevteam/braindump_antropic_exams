import type { TutorReply, ToolName } from "../agents/ai-tutor/types";
import type { DraftState } from "./practice-types";

export type TutorTextField = "approach" | "message" | "concept" | "nextStep";
export type TutorActivityStage = "question" | "model" | "memory" | "compaction" | ToolName;
export type TutorStreamReply = TutorReply & { state: DraftState };

// This is the complete browser-facing protocol. No model/tool wire payloads belong here.
export type TutorStreamEvent =
  | { type: "start"; runId: string; answerRevealed: boolean }
  | { type: "activity"; id: string; stage: TutorActivityStage; state: "active" | "done" | "denied" }
  | { type: "delta"; field: TutorTextField; text: string }
  | { type: "reset"; reason: "retry" }
  | { type: "complete"; reply: TutorStreamReply }
  | { type: "error"; error: string; code: string };

export type TutorRuntimeEvent = Exclude<TutorStreamEvent, { type: "complete" | "error" }>;
