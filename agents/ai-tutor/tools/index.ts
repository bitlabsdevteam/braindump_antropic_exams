import { getAnswer, getCertificationForQuestion, getQuestion, getQuestions } from "../../../lib/db";
import { isRevealed, learningContext } from "../context/session";
import type { AgentContext, RelatedQuestion, ToolName } from "../types";

export class ToolPermissionError extends Error {}
export type ToolEnvironment = { sessionId: string; context: AgentContext };

function publicQuestion(question: NonNullable<ReturnType<typeof getQuestion>>) {
  return { id: question.id, sourceKey: question.sourceKey, type: question.type, prompt: question.prompt, selectionCount: question.selectionCount, options: question.options, matchItems: question.matchItems, domainName: question.domainName, scenarioTitle: question.scenarioTitle };
}

export function runTool(name: ToolName, raw: Record<string, unknown>, env: ToolEnvironment): unknown {
  const { context, sessionId } = env;
  if (name === "get_question_context") return publicQuestion(context.question);
  if (name === "get_revealed_answer") {
    if (!isRevealed(sessionId, context.question.id)) throw new ToolPermissionError("The answer has not been revealed in this session.");
    const answer = getAnswer(context.question.id); if (!answer) throw new Error("Answer not found"); return answer;
  }
  if (name === "get_session_learning_context") return { revealedByDomain: learningContext(sessionId), scope: "current anonymous study session only" };
  if (name === "find_related_questions") {
    const limit = typeof raw.limit === "number" && Number.isInteger(raw.limit) ? Math.min(Math.max(raw.limit, 1), 5) : 3;
    const domainNumber = typeof raw.domainNumber === "number" && Number.isInteger(raw.domainNumber) ? raw.domainNumber : context.question.domainNumber;
    const all = getQuestions(context.certificationSlug);
    return all.filter((q) => q.id !== context.question.id && (domainNumber === null || q.domainNumber === domainNumber)).slice(0, limit).map<RelatedQuestion>((q) => ({ id: q.id, sourceKey: q.sourceKey, prompt: q.prompt, domainName: q.domainName, scenarioTitle: q.scenarioTitle, type: q.type }));
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createContext(questionId: number, state: AgentContext["state"]): AgentContext {
  const question = getQuestion(questionId); if (!question) throw new Error("Question not found");
  const certification = getCertificationByQuestion(questionId); if (!certification) throw new Error("Certification not found");
  return { question, certificationSlug: certification.slug, certificationTitle: certification.title, state, history: [] };
}
function getCertificationByQuestion(questionId: number) {
  return getCertificationForQuestion(questionId);
}
