import { NextResponse } from "next/server";
import { createSessionId, ensureSession, hide, reveal } from "../../../../../agents/ai-tutor";
import { getCertificationForQuestion, getQuestion, getAnswer } from "../../../../../lib/db";

export const runtime = "nodejs";
const sessionCookie = "ai_tutor_session";
function withSession(request: Request) {
  const existing = request.headers.get("cookie")?.match(/(?:^|;\s*)ai_tutor_session=([^;]+)/)?.[1]; const id = existing && /^[A-Za-z0-9_-]{20,}$/.test(existing) ? existing : createSessionId(); ensureSession(id); return id;
}
function json(data: unknown, id: string, status = 200) { const response = NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } }); response.cookies.set(sessionCookie, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 24 * 60 * 60 }); return response; }
async function questionId(params: Promise<{ id: string }>) { const { id } = await params; const value = Number(id); return Number.isInteger(value) && value > 0 ? value : undefined; }
function allowedOrigin(request: Request) { const origin = request.headers.get("origin"); return !origin || origin === new URL(request.url).origin; }

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const sessionId = withSession(request); const id = await questionId(params); if (!id) return json({ error: "Invalid question id" }, sessionId, 400);
  const question = getQuestion(id); const certification = getCertificationForQuestion(id); const answer = getAnswer(id);
  if (!question || !certification || !answer) return json({ error: "Answer not found" }, sessionId, 404);
  reveal(sessionId, id, certification.slug, question.domainName); return json(answer, sessionId);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const sessionId = withSession(request); const id = await questionId(params); if (!id) return json({ error: "Invalid question id" }, sessionId, 400);
  hide(sessionId, id); return json({ ok: true }, sessionId);
}
