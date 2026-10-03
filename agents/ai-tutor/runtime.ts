import { askTutorAgent, isTransientFoundryError } from "../../lib/foundry";
import { TutorServiceError, tutorFailure } from "../../lib/tutor-errors";
import { prepareMemory, contextBudget, bytes, type CompactModel } from "./memory/compaction";
import { appendTurn, importLegacyTurns, conversationText } from "./memory/store";
import { getTutorPrompt } from "./context/prompt";
import { addMessage, history, runActive, sessionDatabase } from "./context/session";
import { PracticeError, recordAssistance, revisionMatches } from "../../lib/practice";
import { startTrace, finishTrace, traceEvent } from "./harness/trace";
import { runTool, ToolPermissionError } from "./tools";
import type { TutorRuntimeEvent } from "../../lib/tutor-stream-types";
import type {
  AgentContext,
  AgentRequest,
  FinalAnswer,
  RelatedQuestion,
  ToolName,
  TutorMessage,
  TutorReply,
} from "./types";

export const maxCalls = 4;
const maxTools = maxCalls - 1;
const deadlineMs = 60_000;
type ToolResult = { tool: ToolName; result: unknown };

export function runtimeInstructions(callsRemaining: number, toolsRemaining: number) {
  const budget =
    callsRemaining === 1 || toolsRemaining === 0
      ? "This is a final-only call. Return a final response now; no tools are available. Use the supplied context and tool results. If something is missing, state that limitation rather than inventing it."
      : "Choose a tool only when its result is necessary; the active question is already supplied. Reserve one model call for the final response.";
  return `${getTutorPrompt().text}\n\nYou operate through a bounded agent harness. Tools: get_question_context, find_related_questions, get_revealed_answer, get_session_learning_context, search_conversation. Use get_revealed_answer only after the server grants access. Each toolResults entry names its tool and contains its result. Never claim a tool result you did not receive. Model calls remaining, including this call: ${callsRemaining}. Tool calls remaining: ${toolsRemaining}. ${budget} A final response must satisfy the required JSON fields in the base instructions.`;
}
function inputFor(context: AgentContext, message: string, toolResults: ToolResult[]) {
  return JSON.stringify(
    {
      certification: context.certificationTitle,
      activeQuestion: {
        id: context.question.id,
        sourceKey: context.question.sourceKey,
        type: context.question.type,
        prompt: context.question.prompt,
        domainName: context.question.domainName,
        scenarioTitle: context.question.scenarioTitle,
        scenarioDescription: context.question.scenarioDescription,
        selectionCount: context.question.selectionCount,
        options: context.question.options,
        matchItems: context.question.matchItems,
      },
      learnerState: context.state,
      conversation: context.history,
      memory: context.memory,
      learnerMessage: message,
      toolResults,
    },
    null,
    2,
  );
}
function validateFinal(value: FinalAnswer): FinalAnswer {
  for (const field of [
    value.message,
    value.concept,
    value.nextStep,
    ...(value.approach === undefined ? [] : [value.approach]),
  ])
    if (!field.trim() || field.length > 8000)
      throw new Error("The tutor produced an invalid response");
  return value;
}

function completedConversation(messages: TutorMessage[]): TutorMessage[] {
  const completed: TutorMessage[] = [];
  let pending: TutorMessage | undefined;
  for (const message of messages) {
    if (message.role === "user") pending = message;
    else if (pending) {
      completed.push(pending, message);
      pending = undefined;
    }
  }
  return completed;
}

export async function runTutorAgent(
  request: AgentRequest,
  context: AgentContext,
  dependencies: {
    model?: typeof askTutorAgent;
    timeoutMs?: number;
    onEvent?: (event: TutorRuntimeEvent) => void;
    compactor?: CompactModel;
  } = {},
): Promise<TutorReply> {
  const prompt = getTutorPrompt();
  const trace = startTrace(prompt.hash);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? deadlineMs);
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const model = dependencies.model ?? askTutorAgent;
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new TutorServiceError("timeout");
    if (
      !runActive(request.sessionId, request.requestId) ||
      !revisionMatches(request.sessionId, request.questionId, context.state.revision)
    )
      throw new PracticeError("The question or conversation changed. Please ask again.", 409);
  };
  const tools: ToolResult[] = [];
  const emit = (event: TutorRuntimeEvent) => {
    assertCurrent();
    dependencies.onEvent?.(event);
  };
  let streamedAssistance = false;
  const seen = new Set<string>();
  let calls = 0;
  let toolCalls = 0;
  let retried = false;
  try {
    assertCurrent();
    emit({ type: "start", runId: trace.runId, answerRevealed: context.state.answerRevealed });
    emit({ type: "activity", id: "question", stage: "question", state: "done" });
    emit({ type: "activity", id: "memory", stage: "memory", state: "active" });
    importLegacyTurns(
      request.sessionId,
      request.questionId,
      context.question.sourceKey,
      context.state.answerRevealed,
    );
    const memory = await prepareMemory({
      sessionId: request.sessionId,
      sourceKey: context.question.sourceKey,
      revealed: context.state.answerRevealed,
      signal: controller.signal,
      assertCurrent,
      model: dependencies.compactor,
      onActivity: (state) =>
        emit({ type: "activity", id: "compaction", stage: "compaction", state }),
      onTrace: (data) => traceEvent(trace, String(data.event), data),
    });
    // Legacy cache contains only short-lived context; new complete exchanges use the durable archive.
    context.history =
      memory.recent.length || memory.summary || memory.omittedOlderTurns
        ? memory.recent.flatMap((turn) => [
            { role: "user" as const, content: turn.user },
            { role: "assistant" as const, content: conversationText(turn.assistant) },
          ])
        : completedConversation(history(request.sessionId, request.questionId));
    context.memory = {
      preferences: memory.preferences.map(({ key, value }) => ({ key, value })),
      summary: memory.summary,
      omittedOlderTurns: memory.omittedOlderTurns,
    };
    emit({ type: "activity", id: "memory", stage: "memory", state: "done" });
    while (calls < maxCalls) {
      assertCurrent();
      calls += 1;
      traceEvent(trace, "model_call", { count: calls });
      emit({ type: "activity", id: `model-${calls}`, stage: "model", state: "active" });
      let decision;
      const system = runtimeInstructions(
        maxCalls - calls + 1,
        Math.min(maxTools - toolCalls, maxCalls - calls),
      );
      let input = inputFor(context, request.message, tools);
      // UTF-8 bytes conservatively bound text tokens; reserve output and wire/schema overhead.
      const { inputBytes: budget, outputTokens } = contextBudget();
      while (bytes(system) + bytes(input) > budget && context.history.length) {
        context.history.splice(0, 2);
        if (context.memory) context.memory.omittedOlderTurns = true;
        input = inputFor(context, request.message, tools);
      }
      if (bytes(system) + bytes(input) > budget) throw new TutorServiceError("context_limit");
      traceEvent(trace, "context_budget", {
        inputBytes: bytes(system) + bytes(input),
        budget,
        reservedOutputTokens: outputTokens,
      });
      try {
        // Race the deadline as identity token acquisition may not honor fetch cancellation.
        decision = await new Promise<Awaited<ReturnType<typeof askTutorAgent>>>(
          (resolve, reject) => {
            const stopped = () => reject(new TutorServiceError("timeout"));
            controller.signal.addEventListener("abort", stopped, { once: true });
            if (controller.signal.aborted) {
              stopped();
              return;
            }
            model({
              system,
              input,
              signal: controller.signal,
              onUsage: (usage) => traceEvent(trace, "usage", usage),
              onDelta: dependencies.onEvent
                ? ({ field, text }) => {
                    assertCurrent();
                    if (
                      !["approach", "message", "concept", "nextStep"].includes(field) ||
                      typeof text !== "string"
                    )
                      throw new TutorServiceError("invalid_output");
                    if (!text) return;
                    // Even a cancelled partial hint has helped the learner. Record exposure to
                    // AI assistance now; increment hint stage and save transcript only on success.
                    if (!streamedAssistance && !context.state.answerRevealed && text.trim()) {
                      recordAssistance(request.sessionId, request.questionId, false);
                      streamedAssistance = true;
                    }
                    emit({ type: "delta", field, text });
                  }
                : undefined,
            })
              .then(resolve, reject)
              .finally(() => controller.signal.removeEventListener("abort", stopped));
          },
        );
      } catch (error) {
        if (
          !retried &&
          calls < maxCalls &&
          !controller.signal.aborted &&
          isTransientFoundryError(error)
        ) {
          retried = true;
          traceEvent(trace, "retry", { reason: "transient_provider_error" });
          emit({ type: "reset", reason: "retry" });
          continue;
        }
        throw error;
      }
      assertCurrent();
      emit({ type: "activity", id: `model-${calls}`, stage: "model", state: "done" });
      if (decision.type === "final") {
        const final = validateFinal(decision);
        const known = new Map<number, RelatedQuestion>();
        for (const item of tools)
          if (item.tool === "find_related_questions" && Array.isArray(item.result))
            for (const related of item.result)
              if (related && typeof related === "object" && "id" in related)
                known.set(Number(related.id), related as RelatedQuestion);
        const relatedQuestions = (final.relatedQuestionIds ?? [])
          .map((id) => known.get(id))
          .filter((item): item is RelatedQuestion => Boolean(item))
          .slice(0, 5);
        const reply = {
          ...(final.approach === undefined ? {} : { approach: final.approach }),
          message: final.message,
          concept: final.concept,
          nextStep: final.nextStep,
          relatedQuestions,
          runId: trace.runId,
        };
        sessionDatabase()
          .transaction(() => {
            assertCurrent();
            // The current message is already in learnerMessage. Persist only completed
            // exchanges so a rejected request cannot poison later conversation context.
            addMessage(request.sessionId, request.questionId, {
              role: "user",
              content: request.message,
            });
            addMessage(request.sessionId, request.questionId, {
              role: "assistant",
              content: JSON.stringify({
                ...(final.approach === undefined ? {} : { approach: final.approach }),
                message: final.message,
                concept: final.concept,
                nextStep: final.nextStep,
              }),
            });
            appendTurn({
              sessionId: request.sessionId,
              sourceKey: context.question.sourceKey,
              requestId: request.requestId,
              revealed: context.state.answerRevealed,
              user: request.message,
              reply: {
                approach: final.approach,
                message: final.message,
                concept: final.concept,
                nextStep: final.nextStep,
              },
              tools: tools.map((item) => ({
                tool: item.tool,
                allowed: !(
                  item.result &&
                  typeof item.result === "object" &&
                  "error" in item.result
                ),
              })),
              promptHash: prompt.hash,
              updates: final.memoryUpdates ?? [],
            });
            if (!context.state.answerRevealed)
              recordAssistance(
                request.sessionId,
                request.questionId,
                context.state.intent === "hint",
              );
          })
          .immediate();
        finishTrace(trace, "success");
        return reply;
      }
      if (calls === maxCalls) {
        traceEvent(trace, "tool", {
          name: decision.tool,
          allowed: false,
          reason: "final_call_reserved",
        });
        throw new Error("The tutor did not finish within its response limit. Please try again.");
      }
      if (toolCalls >= maxTools)
        throw new Error("The tutor reached its tool limit. Please try again.");
      const fingerprint = `${decision.tool}:${JSON.stringify(decision.arguments)}`;
      if (seen.has(fingerprint))
        throw new Error("The tutor repeated a tool request. Please try again.");
      seen.add(fingerprint);
      toolCalls += 1;
      emit({ type: "activity", id: `tool-${toolCalls}`, stage: decision.tool, state: "active" });
      let toolState: "done" | "denied" = "done";
      try {
        const result = runTool(decision.tool, decision.arguments, {
          sessionId: request.sessionId,
          context,
        });
        tools.push({ tool: decision.tool, result });
        traceEvent(trace, "tool", { name: decision.tool, allowed: true });
      } catch (error) {
        toolState = "denied";
        tools.push({
          tool: decision.tool,
          result: {
            error: error instanceof ToolPermissionError ? "Permission denied" : "Tool unavailable",
          },
        });
        traceEvent(trace, "tool", { name: decision.tool, allowed: false });
      }
      emit({ type: "activity", id: `tool-${toolCalls}`, stage: decision.tool, state: toolState });
    }
    throw new Error("The tutor reached its response limit. Please try again.");
  } catch (error) {
    const failure = tutorFailure(error);
    traceEvent(trace, "failure", {
      code: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    });
    finishTrace(trace, failure.code === "timeout" ? "timeout" : "error");
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}
