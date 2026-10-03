import { getCertification } from "../../../lib/db";
import {
  errorResponse,
  jsonResponse,
  learnerSession,
  readBody,
  validateOrigin,
} from "../../../lib/http";
import {
  getState,
  practiceSnapshot,
  PracticeError,
  questionContext,
  recommendations,
  restartExam,
  retryQuestion,
  saveDraft,
  setPracticeSettings,
  submitAttempt,
} from "../../../lib/practice";
import { ensureSession, resetSession } from "../../../agents/ai-tutor/context/session";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const id = learnerSession(request);
  try {
    const url = new URL(request.url);
    const slug = url.searchParams.get("certification") || "";
    if (!getCertification(slug)) throw new PracticeError("Certification not found", 404);
    const key = url.searchParams.get("questionId");
    if (key !== null) {
      const questionId = Number(key);
      if (!Number.isSafeInteger(questionId) || questionId < 1)
        throw new PracticeError("Invalid question id");
      if (questionContext(questionId).certification.slug !== slug)
        throw new PracticeError("Question not found", 404);
      return jsonResponse(
        { state: getState(id, questionId), recommendations: recommendations(id, questionId) },
        id,
      );
    }
    return jsonResponse(practiceSnapshot(id, slug), id);
  } catch (error) {
    return errorResponse(error, id);
  }
}
export async function POST(request: Request) {
  const id = learnerSession(request);
  try {
    const body = await readBody(request);
    const slug = body.certification;
    if (typeof slug !== "string" || !getCertification(slug))
      throw new PracticeError("Certification not found", 404);
    if (body.action === "restart") return jsonResponse({ snapshot: restartExam(id, slug) }, id);
    if (body.action === "navigate" || body.action === "start") {
      setPracticeSettings(
        id,
        slug,
        body.action,
        body.action === "start" ? body.timed : body.sourceKey,
      );
      return jsonResponse({ snapshot: practiceSnapshot(id, slug) }, id);
    }
    if (!Number.isSafeInteger(body.questionId) || Number(body.questionId) < 1)
      throw new PracticeError("Invalid question id");
    const questionId = body.questionId as number;
    if (questionContext(questionId).certification.slug !== slug)
      throw new PracticeError("Question not found", 404);
    if (body.action === "draft")
      return jsonResponse(
        { state: saveDraft(id, questionId, body.selectedKeys, body.reasoning, body.revision) },
        id,
      );
    if (body.action === "retry")
      return jsonResponse(
        {
          state: retryQuestion(id, questionId, body.revision),
          snapshot: practiceSnapshot(id, slug),
        },
        id,
      );
    if (body.action === "submit") {
      if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId))
        throw new PracticeError("Invalid submission id");
      return jsonResponse(
        {
          ...submitAttempt(id, questionId, body.requestId, body.revision),
          snapshot: practiceSnapshot(id, slug),
          recommendations: recommendations(id, questionId),
        },
        id,
      );
    }
    throw new PracticeError("Unknown practice action");
  } catch (error) {
    return errorResponse(error, id);
  }
}
export async function DELETE(request: Request) {
  const id = learnerSession(request);
  try {
    validateOrigin(request);
    resetSession(id);
    const next = ensureSession();
    return jsonResponse({ ok: true }, next);
  } catch (error) {
    return errorResponse(error, id);
  }
}
