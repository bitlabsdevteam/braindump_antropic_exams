import { NextResponse } from "next/server";
import { beginRun, createContext, createSessionId, ensureSession, finishRun, isRevealed, resetSession, runTutorAgent, runsInLastMinute } from "../../../agents/ai-tutor";
import type { Question } from "../../../lib/types";

export const runtime = "nodejs";
const sessionCookie = "ai_tutor_session";
const maxBodyBytes = 12_000;

function response(data: unknown, sessionId: string, status = 200) {
  const result = NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
  result.cookies.set(sessionCookie, sessionId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 24 * 60 * 60 });
  return result;
}
function session(request: Request) {
  const existing = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${sessionCookie}=([^;]+)`))?.[1];
  const id = existing && /^[A-Za-z0-9_-]{20,}$/.test(existing) ? existing : createSessionId(); ensureSession(id); return id;
}
function validSelections(question: Question, selected: string[]) {
  const allowed = question.type === "scenario_matching" ? new Set(question.matchItems.flatMap((item) => question.options.map((option) => `${item.key}:${option.key}`))) : new Set(question.options.map((option) => option.key));
  const required = question.type === "scenario_matching" ? question.matchItems.length : question.selectionCount;
  return new Set(selected).size === selected.length && selected.length <= required && selected.every((key) => allowed.has(key));
}
function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin"); return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  if (!allowedOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const contentLength = Number(request.headers.get("content-length") ?? 0); if (contentLength > maxBodyBytes) return NextResponse.json({ error: "Tutor request is too large" }, { status: 400 });
  const sessionId = session(request); let body: Record<string, unknown>;
  try { const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > maxBodyBytes) return response({ error: "Tutor request is too large" }, sessionId, 400); body = JSON.parse(raw) as Record<string, unknown>; }
  catch { return response({ error: "Malformed tutor request" }, sessionId, 400); }
  const questionId = body.questionId; const message = body.message; const requestId = body.requestId; const selectedKeys = body.selectedKeys;
  if (!Number.isInteger(questionId) || typeof message !== "string" || !message.trim() || message.length > 1_000 || typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId) || !Array.isArray(selectedKeys) || selectedKeys.some((key) => typeof key !== "string")) return response({ error: "Invalid tutor request" }, sessionId, 400);
  try {
    const context = createContext(questionId as number, { selectedKeys: selectedKeys as string[], answerRevealed: isRevealed(sessionId, questionId as number) });
    if (!validSelections(context.question, selectedKeys as string[])) return response({ error: "Invalid selection" }, sessionId, 400);
    if (runsInLastMinute(sessionId) >= 10) return response({ error: "Please wait a moment before sending another tutor request." }, sessionId, 429);
    if (!beginRun(sessionId, requestId)) return response({ error: "A tutor response is already in progress. Please wait and try again." }, sessionId, 429);
    const tutor = await runTutorAgent({ sessionId, questionId: questionId as number, message: message.trim(), requestId, learnerState: context.state }, context);
    finishRun(sessionId, requestId);
    return response(tutor, sessionId);
  } catch (error) {
    if (typeof requestId === "string") finishRun(sessionId, requestId);
    console.error("Tutor agent failed", error instanceof Error ? error.message : "unknown error");
    const message = error instanceof Error && error.message.includes("Question not found") ? "Question not found" : "The AI tutor is temporarily unavailable. Please try again.";
    return response({ error: message }, sessionId, message === "Question not found" ? 404 : 503);
  }
}

export async function DELETE(request: Request) { if (!allowedOrigin(request)) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 }); const id = session(request); resetSession(id); return response({ ok: true }, createSessionId()); }
