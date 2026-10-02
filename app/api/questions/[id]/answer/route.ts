import { hide } from "../../../../../agents/ai-tutor/context/session";
import {
  errorResponse,
  jsonResponse,
  learnerSession,
  validateOrigin,
} from "../../../../../lib/http";
import {
  getState,
  PracticeError,
  questionContext,
  revealAnswer,
} from "../../../../../lib/practice";

export const runtime = "nodejs";
async function questionId(params: Promise<{ id: string }>) {
  const { id } = await params;
  const value = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(value) || value < 1)
    throw new PracticeError("Invalid question id");
  questionContext(value);
  return value;
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const sessionId = learnerSession(request);
  try {
    validateOrigin(request);
    const id = await questionId(params);
    return jsonResponse(revealAnswer(sessionId, id), sessionId);
  } catch (error) {
    return errorResponse(error, sessionId);
  }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const sessionId = learnerSession(request);
  try {
    validateOrigin(request);
    const id = await questionId(params);
    hide(sessionId, id);
    return jsonResponse({ state: getState(sessionId, id) }, sessionId);
  } catch (error) {
    return errorResponse(error, sessionId);
  }
}
