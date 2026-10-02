import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";

export type TutorModelInput = { system: string; input: string };
export type TutorModelOutput = { message: string; concept: string; nextStep: string };
export type FoundryUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
type ModelOptions = { signal?: AbortSignal; onUsage?: (usage: FoundryUsage) => void };
const toolNames = [
  "get_question_context",
  "find_related_questions",
  "get_revealed_answer",
  "get_session_learning_context",
] as const;
export type AgentModelOutput =
  | { type: "tool"; tool: (typeof toolNames)[number]; arguments: Record<string, unknown> }
  | ({ type: "final"; relatedQuestionIds?: number[] } & TutorModelOutput);

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

// Strict structured outputs require every property to be declared and required.
// Unused fields are explicitly null; tools cannot introduce arbitrary arguments.
export const agentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["tool", "final"] },
    tool: { type: ["string", "null"], enum: [...toolNames, null] },
    arguments: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        limit: { type: ["integer", "null"] },
        domainNumber: { type: ["integer", "null"] },
      },
      required: ["limit", "domainNumber"],
    },
    message: { type: ["string", "null"] },
    concept: { type: ["string", "null"] },
    nextStep: { type: ["string", "null"] },
    relatedQuestionIds: { type: ["array", "null"], items: { type: "integer" } },
  },
  required: ["type", "tool", "arguments", "message", "concept", "nextStep", "relatedQuestionIds"],
};

let client: ReturnType<AIProjectClient["getOpenAIClient"]> | undefined;
let clientKey: string | undefined;

export function foundryConfiguration() {
  const raw = process.env.FOUNDRY_PROJECT_ENDPOINT?.trim();
  if (!raw) throw new Error("FOUNDRY_PROJECT_ENDPOINT is not configured");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("FOUNDRY_PROJECT_ENDPOINT must be a valid project URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/api\/projects\/[^/]+\/?$/.test(endpoint.pathname)
  ) {
    throw new Error(
      "FOUNDRY_PROJECT_ENDPOINT must be an HTTPS Foundry project URL ending in /api/projects/<project>",
    );
  }
  const model = process.env.FOUNDRY_MODEL?.trim();
  if (!model || model.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model))
    throw new Error("FOUNDRY_MODEL must name your existing Foundry model deployment");
  const credential =
    process.env.FOUNDRY_CREDENTIAL?.trim() ||
    (process.env.NODE_ENV === "production" ? "managed_identity" : "default");
  if (credential !== "default" && credential !== "managed_identity")
    throw new Error("FOUNDRY_CREDENTIAL must be default or managed_identity");
  return {
    endpoint: endpoint.href.replace(/\/$/, ""),
    model,
    credential,
    clientId: process.env.AZURE_CLIENT_ID?.trim(),
  };
}

function getClient() {
  const configuration = foundryConfiguration();
  const key = JSON.stringify([
    configuration.endpoint,
    configuration.credential,
    configuration.clientId,
  ]);
  if (!client || clientKey !== key) {
    const credential =
      configuration.credential === "managed_identity"
        ? new ManagedIdentityCredential(
            configuration.clientId ? { clientId: configuration.clientId } : {},
          )
        : new DefaultAzureCredential();
    const project = new AIProjectClient(configuration.endpoint, credential, {
      retryOptions: { maxRetries: 0 },
    });
    // The application harness owns retries and deadlines. Do not duplicate them in the SDK.
    client = project.getOpenAIClient({ maxRetries: 0, timeout: 55_000 });
    clientKey = key;
  }
  return { client, model: configuration.model };
}

export function isTransientFoundryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; statusCode?: unknown; name?: unknown; code?: unknown };
  const status = value.status ?? value.statusCode;
  if (typeof status === "number") return [408, 429, 500, 502, 503, 504].includes(status);
  return (
    value.name === "APIConnectionError" ||
    value.name === "APIConnectionTimeoutError" ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(String(value.code))
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 8000;
}

function parseTutorOutput(value: unknown): TutorModelOutput {
  if (
    !object(value) ||
    !validText(value.message) ||
    !validText(value.concept) ||
    !validText(value.nextStep)
  )
    throw new Error("Foundry returned an invalid tutor response");
  return { message: value.message, concept: value.concept, nextStep: value.nextStep };
}

export function parseAgentModelOutput(value: unknown): AgentModelOutput {
  const invalid = () => new Error("Foundry returned an invalid agent decision");
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "type",
          "tool",
          "arguments",
          "message",
          "concept",
          "nextStep",
          "relatedQuestionIds",
        ].includes(key),
    )
  )
    throw invalid();
  if (value.type === "tool") {
    if (!toolNames.includes(value.tool as (typeof toolNames)[number]) || !object(value.arguments))
      throw invalid();
    if (
      value.message !== null ||
      value.concept !== null ||
      value.nextStep !== null ||
      value.relatedQuestionIds !== null
    )
      throw invalid();
    const args = value.arguments;
    if (
      Object.keys(args).some((key) => !["limit", "domainNumber"].includes(key)) ||
      !("limit" in args) ||
      !("domainNumber" in args)
    )
      throw invalid();
    if (
      args.limit !== null &&
      (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 5)
    )
      throw invalid();
    if (
      args.domainNumber !== null &&
      (!Number.isInteger(args.domainNumber) ||
        Number(args.domainNumber) < 1 ||
        Number(args.domainNumber) > 100)
    )
      throw invalid();
    if (
      value.tool !== "find_related_questions" &&
      (args.limit !== null || args.domainNumber !== null)
    )
      throw invalid();
    return {
      type: "tool",
      tool: value.tool as (typeof toolNames)[number],
      arguments: Object.fromEntries(Object.entries(args).filter(([, entry]) => entry !== null)),
    };
  }
  if (value.type !== "final" || value.tool !== null || value.arguments !== null) throw invalid();
  const ids = value.relatedQuestionIds;
  if (
    ids !== null &&
    (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
  )
    throw invalid();
  return {
    type: "final",
    ...parseTutorOutput(value),
    relatedQuestionIds: Array.isArray(ids) ? [...new Set(ids as number[])] : undefined,
  };
}

async function generate(
  { system, input, signal, onUsage }: TutorModelInput & ModelOptions,
  schema: Record<string, unknown>,
  name: string,
): Promise<unknown> {
  const { client: openai, model } = getClient();
  const response = await openai.responses.create(
    {
      model,
      instructions: system,
      input,
      store: false,
      max_output_tokens: 2000,
      text: { format: { type: "json_schema", name, schema, strict: true } },
    },
    { signal },
  );
  if (response.usage)
    onUsage?.({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
    });
  if (response.status !== "completed")
    throw new Error("Foundry could not complete the tutor response");
  const raw = response.output_text?.trim();
  if (!raw || raw.length > 32_000)
    throw new Error("Foundry returned an empty or oversized response");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Foundry returned invalid JSON");
  }
}

export async function askTutor(input: TutorModelInput & ModelOptions): Promise<TutorModelOutput> {
  return parseTutorOutput(await generate(input, tutorSchema, "tutor_response"));
}

export async function askTutorAgent(
  input: TutorModelInput & ModelOptions,
): Promise<AgentModelOutput> {
  return parseAgentModelOutput(await generate(input, agentSchema, "tutor_agent_decision"));
}
