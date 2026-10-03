import { learnerSession, jsonResponse, errorResponse, readBody } from "../../../../lib/http";
import { getState, PracticeError, questionContext } from "../../../../lib/practice";
import { forgetMemory, memoryView } from "../../../../agents/ai-tutor/memory/store";
import { preferenceValues, type PreferenceKey } from "../../../../lib/tutor-memory-types";

export const runtime = "nodejs";
function questionId(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new PracticeError("Invalid question id");
  questionContext(value as number);
  return value as number;
}
export async function GET(request: Request) {
  const id = learnerSession(request);
  try {
    const params = new URL(request.url).searchParams;
    const question = questionId(Number(params.get("questionId")));
    const rawBefore = params.get("before");
    const before = rawBefore === null ? undefined : Number(rawBefore);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new PracticeError("Invalid history cursor");
    // The request cannot select another learner or claim that an answer is revealed.
    return jsonResponse(memoryView(id, question, before), id);
  } catch (error) {
    return errorResponse(error, id);
  }
}
export async function DELETE(request: Request) {
  const id = learnerSession(request);
  try {
    const body = await readBody(request);
    const question = questionId(body.questionId);
    if (
      body.key !== undefined &&
      (typeof body.key !== "string" ||
        !Object.prototype.hasOwnProperty.call(preferenceValues, body.key))
    )
      throw new PracticeError("Invalid preference");
    forgetMemory(id, body.key as PreferenceKey | undefined);
    return jsonResponse({ state: getState(id, question) }, id);
  } catch (error) {
    return errorResponse(error, id);
  }
}
