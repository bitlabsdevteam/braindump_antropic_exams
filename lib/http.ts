import { NextResponse } from "next/server";
import { ensureSession, sessionExpires } from "../agents/ai-tutor/context/session";
import { PracticeError } from "./practice";

export function learnerSession(request: Request) {
  const candidate = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)ai_tutor_session=([A-Za-z0-9_-]{32})(?:;|$)/)?.[1];
  return ensureSession(candidate);
}
export function jsonResponse(data: unknown, id: string, status = 200) {
  const response = NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
  return withLearnerCookie(response, id);
}
export function withLearnerCookie(response: NextResponse, id: string) {
  const expiresAt = sessionExpires(id);
  // A cancelled old request must not clear/replace the fresh cookie issued by reset.
  if (expiresAt > Date.now())
    response.cookies.set("ai_tutor_session", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: new Date(expiresAt),
    });
  return response;
}
export function validateOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const target = new URL(request.url);
  // Next may construct request.url with its internal hostname. The incoming Host
  // header remains the browser-facing authority; never trust forwarded origins.
  const host = request.headers.get("host") || target.host;
  let source: URL;
  try {
    source = new URL(origin);
  } catch {
    throw new PracticeError("Invalid request origin", 403);
  }
  if (source.origin !== origin || source.host !== host || source.protocol !== target.protocol)
    throw new PracticeError("Invalid request origin", 403);
}
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  validateOrigin(request);
  const limit = 12_000;
  if (Number(request.headers.get("content-length")) > limit)
    throw new PracticeError("Request is too large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PracticeError("Missing request body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new PracticeError("Request is too large", 413);
    }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new PracticeError("Malformed request");
  }
}
export function errorResponse(error: unknown, id: string) {
  return jsonResponse(
    {
      error:
        error instanceof PracticeError
          ? error.message
          : "The request could not be completed. Please try again.",
    },
    id,
    error instanceof PracticeError ? error.status : 500,
  );
}
