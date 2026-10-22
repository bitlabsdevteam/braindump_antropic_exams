import {
  errorResponse,
  jsonResponse,
  learnerSession,
  readBody,
  validateOrigin,
} from "../../../../../lib/http";
import { openStaticHint, PracticeError, questionContext } from "../../../../../lib/practice";

export const runtime = "nodejs";
// Hints are served here rather than in page props so opening one is always recorded as
// assistance on the server, and so they never appear in the initial page source.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const sessionId = learnerSession(request);
  try {
    validateOrigin(request);
    const { id } = await params;
    const questionId = Number(id);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(questionId) || questionId < 1)
      throw new PracticeError("Invalid question id");
    questionContext(questionId);
    const body = await readBody(request);
    return jsonResponse(openStaticHint(sessionId, questionId, body.stage), sessionId);
  } catch (error) {
    return errorResponse(error, sessionId);
  }
}
