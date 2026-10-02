import type { Question, QuestionType } from "../../lib/types";
import type { TutorIntent } from "../../lib/practice-types";

export type TutorMessage = { role: "user" | "assistant"; content: string };
export type TutorReply = {
  message: string;
  concept: string;
  nextStep: string;
  relatedQuestions: RelatedQuestion[];
  runId: string;
};
export type RelatedQuestion = {
  id: number;
  sourceKey: string;
  prompt: string;
  domainName: string | null;
  scenarioTitle: string | null;
  type: QuestionType;
};
export type LearnerState = {
  selectedKeys: string[];
  answerRevealed: boolean;
  reasoning: string;
  hintStage: number;
  intent: TutorIntent;
  revision: number;
};
export type AgentRequest = {
  sessionId: string;
  questionId: number;
  message: string;
  requestId: string;
  learnerState: LearnerState;
  signal?: AbortSignal;
};
export type AgentContext = {
  question: Question;
  certificationSlug: string;
  certificationTitle: string;
  state: LearnerState;
  history: TutorMessage[];
};
export type ToolName =
  | "get_question_context"
  | "find_related_questions"
  | "get_revealed_answer"
  | "get_session_learning_context";
export type ToolCall = { type: "tool"; tool: ToolName; arguments: Record<string, unknown> };
export type FinalAnswer = {
  type: "final";
  message: string;
  concept: string;
  nextStep: string;
  relatedQuestionIds?: number[];
};
export type AgentDecision = ToolCall | FinalAnswer;
export type TraceEvent = { at: string; event: string; data?: Record<string, unknown> };
