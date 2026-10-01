import OpenAI from "openai";

export type TutorModelInput = {
  system: string;
  input: string;
};

export type TutorModelOutput = {
  message: string;
  concept: string;
  nextStep: string;
};

export type AgentModelOutput =
  | { type: "tool"; tool: "get_question_context" | "find_related_questions" | "get_revealed_answer" | "get_session_learning_context"; arguments: Record<string, unknown> }
  | { type: "final"; message: string; concept: string; nextStep: string; relatedQuestionIds?: number[] };

const tutorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
    concept: { type: "string" },
    nextStep: { type: "string" },
  },
  required: ["message", "concept", "nextStep"],
};

const agentSchema = {
  type: "object", additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["tool", "final"] },
    tool: { type: ["string", "null"], enum: ["get_question_context", "find_related_questions", "get_revealed_answer", "get_session_learning_context", null] },
    arguments: { type: ["object", "null"], additionalProperties: true },
    message: { type: ["string", "null"] }, concept: { type: ["string", "null"] }, nextStep: { type: ["string", "null"] },
    relatedQuestionIds: { type: ["array", "null"], items: { type: "integer" } },
  }, required: ["type", "tool", "arguments", "message", "concept", "nextStep", "relatedQuestionIds"],
};

let client: OpenAI | undefined;

function getClient() {
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT?.trim();
  if (!endpoint) throw new Error("FOUNDRY_PROJECT_ENDPOINT is not configured");
  const apiKey = process.env.FOUNDRY_API_KEY?.trim();
  if (!apiKey) throw new Error("FOUNDRY_API_KEY is not configured");
  const normalizedEndpoint = endpoint.replace(/\/$/, "");
  const baseURL = normalizedEndpoint.endsWith("/openai/v1")
    ? normalizedEndpoint
    : `${normalizedEndpoint}${normalizedEndpoint.endsWith("/openai") ? "/v1" : "/openai/v1"}`;
  client ??= new OpenAI({
    baseURL,
    apiKey,
  });
  return client;
}

export async function askTutor({ system, input }: TutorModelInput): Promise<TutorModelOutput> {
  const openai = getClient();
  const response = await openai.responses.create({
    model: process.env.FOUNDRY_MODEL?.trim() || "gpt-6-astra",
    instructions: system,
    input,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "tutor_response",
        description: "A concise certification tutor response.",
        schema: tutorSchema,
        strict: true,
      },
    },
  });
  const raw = response.output_text?.trim();
  if (!raw) throw new Error("Foundry returned an empty response");
  const parsed = JSON.parse(raw) as Partial<TutorModelOutput>;
  if (typeof parsed.message !== "string" || typeof parsed.concept !== "string" || typeof parsed.nextStep !== "string") {
    throw new Error("Foundry returned an invalid tutor response");
  }
  return { message: parsed.message, concept: parsed.concept, nextStep: parsed.nextStep };
}

export async function askTutorAgent({ system, input, signal }: TutorModelInput & { signal?: AbortSignal }): Promise<AgentModelOutput> {
  const openai = getClient();
  const response = await openai.responses.create({
    model: process.env.FOUNDRY_MODEL?.trim() || "gpt-6-astra", instructions: system, input, store: false,
    max_output_tokens: 2000,
    text: { format: { type: "json_schema", name: "tutor_agent_decision", description: "A tool call or final tutor response.", schema: agentSchema, strict: true } },
  }, { signal });
  const parsed = JSON.parse(response.output_text?.trim() || "{}") as Partial<AgentModelOutput>;
  if (parsed.type === "tool" && (parsed.tool === "get_question_context" || parsed.tool === "find_related_questions" || parsed.tool === "get_revealed_answer" || parsed.tool === "get_session_learning_context") && parsed.arguments && typeof parsed.arguments === "object") return { type: "tool", tool: parsed.tool, arguments: parsed.arguments as Record<string, unknown> };
  if (parsed.type === "final" && typeof parsed.message === "string" && typeof parsed.concept === "string" && typeof parsed.nextStep === "string") return { type: "final", message: parsed.message, concept: parsed.concept, nextStep: parsed.nextStep, relatedQuestionIds: Array.isArray(parsed.relatedQuestionIds) ? parsed.relatedQuestionIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id)) : undefined };
  throw new Error("Foundry returned an invalid agent decision");
}
