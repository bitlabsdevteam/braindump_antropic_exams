import { getAnswer, getCertificationForQuestion, getQuestion } from "../../../lib/db";
import { isRevealed } from "../context/session";
import { learningContext, recommendations } from "../../../lib/practice";
import type { AgentContext, RelatedQuestion, ToolName } from "../types";

export class ToolPermissionError extends Error {}
export type ToolEnvironment = { sessionId: string; context: AgentContext };

function publicQuestion(question: NonNullable<ReturnType<typeof getQuestion>>) {
  return {
    id: question.id,
    sourceKey: question.sourceKey,
    type: question.type,
    prompt: question.prompt,
    selectionCount: question.selectionCount,
    options: question.options,
    matchItems: question.matchItems,
    domainName: question.domainName,
    scenarioTitle: question.scenarioTitle,
    scenarioDescription: question.scenarioDescription,
  };
}

export function runTool(
  name: ToolName,
  raw: Record<string, unknown>,
  env: ToolEnvironment,
): unknown {
  const { context, sessionId } = env;
  if (name === "get_question_context") return publicQuestion(context.question);
  if (name === "get_revealed_answer") {
    if (!isRevealed(sessionId, context.question.id))
      throw new ToolPermissionError("The answer has not been revealed in this session.");
    const answer = getAnswer(context.question.id);
    if (!answer) throw new Error("Answer not found");
    return answer;
  }
  if (name === "get_session_learning_context")
    return {
      independentAttemptsByDomain: learningContext(
        sessionId,
        context.certificationSlug,
        context.question.sourceKey,
      ),
      scope:
        "recorded independent attempts in this certification within the anonymous learner's 30-day history; active question excluded",
    };
  if (name === "find_related_questions") {
    const limit =
      typeof raw.limit === "number" && Number.isInteger(raw.limit)
        ? Math.min(Math.max(raw.limit, 1), 3)
        : 3;
    return recommendations(sessionId, context.question.id).slice(
      0,
      limit,
    ) satisfies RelatedQuestion[];
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createContext(questionId: number, state: AgentContext["state"]): AgentContext {
  const question = getQuestion(questionId);
  if (!question) throw new Error("Question not found");
  const certification = getCertificationByQuestion(questionId);
  if (!certification) throw new Error("Certification not found");
  return {
    question,
    certificationSlug: certification.slug,
    certificationTitle: certification.title,
    state,
    history: [],
  };
}
function getCertificationByQuestion(questionId: number) {
  return getCertificationForQuestion(questionId);
}
