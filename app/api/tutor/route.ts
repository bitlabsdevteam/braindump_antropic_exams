import {
  beginRun,
  createContext,
  finishRun,
  runTutorAgent,
  runsInLastMinute,
} from "../../../agents/ai-tutor";
import { clearConversation } from "../../../agents/ai-tutor/context/session";
import {
  errorResponse,
  jsonResponse,
  learnerSession,
  readBody,
  validateOrigin,
} from "../../../lib/http";
import { getState, PracticeError, questionContext } from "../../../lib/practice";
import type { TutorIntent } from "../../../lib/practice-types";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const sessionId = learnerSession(request);
  let acquired = false;
  let requestId = "";
  try {
    const body = await readBody(request);
    const questionId = body.questionId;
    const message = body.message;
    const intent = body.intent ?? "follow_up";
    if (
      !Number.isSafeInteger(questionId) ||
      Number(questionId) < 1 ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 1000 ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId) ||
      !["hint", "concept", "review", "follow_up"].includes(String(intent))
    )
      throw new PracticeError("Invalid tutor request");
    requestId = body.requestId;
    if (questionContext(questionId as number).question.reviewRequired)
      throw new PracticeError(
        "This question needs source review before AI coaching is available.",
        409,
      );
    const state = getState(sessionId, questionId as number);
    if (body.revision !== state.revision)
      throw new PracticeError("This question changed. Reload progress and try again.", 409);
    if (intent === "review" && !state.visible)
      throw new PracticeError("Reveal the source answer before requesting a review.", 403);
    if (runsInLastMinute(sessionId) >= 10)
      throw new PracticeError("Please wait a minute before sending another tutor request.", 429);
    acquired = beginRun(sessionId, requestId);
    if (!acquired)
      throw new PracticeError(
        "A tutor response is already in progress, or this request was already used.",
        429,
      );
    const context = createContext(questionId as number, {
      selectedKeys: state.selectedKeys,
      answerRevealed: state.visible,
      reasoning: state.reasoning,
      hintStage: Math.min(state.hintCount + 1, 3),
      intent: intent as TutorIntent,
      revision: state.revision,
    });
    const tutor = await runTutorAgent(
      {
        sessionId,
        questionId: questionId as number,
        message: message.trim(),
        requestId,
        learnerState: context.state,
        signal: request.signal,
      },
      context,
    );
    return jsonResponse({ ...tutor, state: getState(sessionId, questionId as number) }, sessionId);
  } catch (error) {
    if (error instanceof PracticeError) return errorResponse(error, sessionId);
    return jsonResponse(
      {
        error:
          "The AI tutor is temporarily unavailable. Your practice progress is saved; please try again.",
      },
      sessionId,
      503,
    );
  } finally {
    if (acquired) finishRun(sessionId, requestId);
  }
}
export async function DELETE(request: Request) {
  const id = learnerSession(request);
  try {
    validateOrigin(request);
    clearConversation(id);
    return jsonResponse({ ok: true }, id);
  } catch (error) {
    return errorResponse(error, id);
  }
}
