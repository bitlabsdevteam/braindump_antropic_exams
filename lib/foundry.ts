import { AIProjectClient } from "@azure/ai-projects";
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import OpenAI from "openai";
import { preferenceValues, type MemoryUpdate } from "./tutor-memory-types";
import { TutorServiceError, tutorFailure } from "./tutor-errors";
import { StreamedTutorJson, type TutorTextDelta } from "./streamed-tutor-json";
export type { TutorTextDelta } from "./streamed-tutor-json";

export type TutorModelInput = { system: string; input: string };
export type TutorModelOutput = { message: string; concept: string; nextStep: string };
export type FoundryUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ModelOptions = {
  signal?: AbortSignal;
  onUsage?: (usage: FoundryUsage) => void;
  onDelta?: (delta: TutorTextDelta) => void;
};
const toolNames = [
  "get_question_context",
  "find_related_questions",
  "get_revealed_answer",
  "get_session_learning_context",
  "search_conversation",
] as const;
export type AgentModelOutput =
  | { type: "tool"; tool: (typeof toolNames)[number]; arguments: Record<string, unknown> }
  | ({
      type: "final";
      approach?: string;
      relatedQuestionIds?: number[];
      memoryUpdates?: MemoryUpdate[];
    } & TutorModelOutput);

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
        query: { type: ["string", "null"] },
      },
      required: ["limit", "domainNumber", "query"],
    },
    approach: {
      type: ["string", "null"],
      description:
        "A brief student-facing teaching approach: the concept or decision criteria to consider. Never provide hidden chain-of-thought, private deliberation, or unrevealed answers. Null for tools.",
    },
    message: { type: ["string", "null"] },
    concept: { type: ["string", "null"] },
    nextStep: { type: ["string", "null"] },
    memoryUpdates: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", enum: Object.keys(preferenceValues) },
          value: {
            type: ["string", "null"],
            enum: [...Object.values(preferenceValues).flat(), null],
          },
          evidence: { type: "string" },
        },
        required: ["key", "value", "evidence"],
      },
    },
    relatedQuestionIds: { type: ["array", "null"], items: { type: "integer" } },
  },
  required: [
    "type",
    "tool",
    "arguments",
    "approach",
    "message",
    "concept",
    "nextStep",
    "relatedQuestionIds",
    "memoryUpdates",
  ],
};

let client: OpenAI | undefined;
let clientKey: string | undefined;

export function foundryConfiguration() {
  const project = process.env.FOUNDRY_PROJECT_ENDPOINT?.trim();
  const resource = process.env.FOUNDRY_OPENAI_ENDPOINT?.trim();
  if ((!project && !resource) || (project && resource))
    throw new TutorServiceError("configuration");
  const mode = project ? "project" : "resource";
  const raw = (project || resource)!;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new TutorServiceError("configuration");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(mode === "project" ? /^\/api\/projects\/[^/]+\/?$/ : /^\/openai\/v1\/?$/).test(
      endpoint.pathname,
    )
  ) {
    throw new TutorServiceError("configuration");
  }
  const model = process.env.FOUNDRY_MODEL?.trim();
  if (!model || model.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model))
    throw new TutorServiceError("configuration");
  const credential =
    process.env.FOUNDRY_CREDENTIAL?.trim() ||
    (mode === "resource" && process.env.FOUNDRY_API_KEY?.trim()
      ? "api_key"
      : process.env.NODE_ENV === "production"
        ? "managed_identity"
        : "default");
  if (
    !["default", "managed_identity", "api_key"].includes(credential) ||
    (credential === "api_key" && (mode !== "resource" || !process.env.FOUNDRY_API_KEY?.trim()))
  )
    throw new TutorServiceError("configuration");
  const maxOutputTokens = Number(process.env.FOUNDRY_MAX_OUTPUT_TOKENS || 4096);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 512 || maxOutputTokens > 16384)
    throw new TutorServiceError("configuration");
  return {
    mode,
    endpoint: endpoint.href.replace(/\/$/, ""),
    model,
    credential,
    clientId: process.env.AZURE_CLIENT_ID?.trim(),
    maxOutputTokens,
  };
}

function getClient() {
  const configuration = foundryConfiguration();
  const key = JSON.stringify([
    configuration.endpoint,
    configuration.credential,
    configuration.clientId,
    configuration.mode,
    configuration.credential === "api_key" ? process.env.FOUNDRY_API_KEY : null,
  ]);
  if (!client || clientKey !== key) {
    const credential =
      configuration.credential === "managed_identity"
        ? new ManagedIdentityCredential(
            configuration.clientId ? { clientId: configuration.clientId } : {},
          )
        : new DefaultAzureCredential();
    // The application harness owns retries and deadlines. Do not duplicate them in the SDK.
    if (configuration.mode === "project") {
      const project = new AIProjectClient(configuration.endpoint, credential, {
        retryOptions: { maxRetries: 0 },
      });
      client = project.getOpenAIClient({ maxRetries: 0, timeout: 55_000 });
    } else {
      // Microsoft documents the OpenAI SDK for Foundry resource v1 endpoints.
      // Always set baseURL explicitly: no request goes to the OpenAI public API.
      client = new OpenAI({
        baseURL: configuration.endpoint,
        // Model responses are private and must never enter Next.js's fetch cache.
        fetch: (url, init) => fetch(url, { ...init, cache: "no-store" }),
        apiKey:
          configuration.credential === "api_key"
            ? process.env.FOUNDRY_API_KEY!.trim()
            : getBearerTokenProvider(credential, "https://ai.azure.com/.default"),
        maxRetries: 0,
        timeout: 55_000,
      });
    }
    clientKey = key;
  }
  return { client, model: configuration.model, maxOutputTokens: configuration.maxOutputTokens };
}

export function isTransientFoundryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; statusCode?: unknown; name?: unknown; code?: unknown };
  const status = value.status ?? value.statusCode;
  if (typeof status === "number") return [408, 429, 500, 502, 503, 504].includes(status);
  return (
    error instanceof OpenAI.APIConnectionError ||
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
    throw new TutorServiceError("invalid_output");
  return { message: value.message, concept: value.concept, nextStep: value.nextStep };
}

export function parseAgentModelOutput(value: unknown): AgentModelOutput {
  const invalid = () => new TutorServiceError("invalid_output");
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "type",
          "tool",
          "arguments",
          "approach",
          "message",
          "concept",
          "nextStep",
          "relatedQuestionIds",
          "memoryUpdates",
        ].includes(key),
    )
  )
    throw invalid();
  if (value.type === "tool") {
    if (!toolNames.includes(value.tool as (typeof toolNames)[number]) || !object(value.arguments))
      throw invalid();
    if (
      (value.memoryUpdates !== undefined && value.memoryUpdates !== null) ||
      value.approach !== null ||
      value.message !== null ||
      value.concept !== null ||
      value.nextStep !== null ||
      value.relatedQuestionIds !== null
    )
      throw invalid();
    const args = value.arguments;
    if (
      Object.keys(args).some((key) => !["limit", "domainNumber", "query"].includes(key)) ||
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
    if (value.tool === "search_conversation") {
      if (
        typeof args.query !== "string" ||
        !args.query.trim() ||
        args.query.length > 100 ||
        args.domainNumber !== null
      )
        throw invalid();
    } else {
      if (args.query !== undefined && args.query !== null) throw invalid();
      if (
        value.tool !== "find_related_questions" &&
        (args.limit !== null || args.domainNumber !== null)
      )
        throw invalid();
    }
    return {
      type: "tool",
      tool: value.tool as (typeof toolNames)[number],
      arguments: Object.fromEntries(Object.entries(args).filter(([, entry]) => entry !== null)),
    };
  }
  if (value.type !== "final" || value.tool !== null || value.arguments !== null) throw invalid();
  if (!validText(value.approach) || value.approach.length > 1000) throw invalid();
  const ids = value.relatedQuestionIds;
  if (
    ids !== null &&
    (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
  )
    throw invalid();
  const updates = value.memoryUpdates ?? [];
  if (!Array.isArray(updates) || updates.length > 4) throw invalid();
  for (const update of updates) {
    if (
      !object(update) ||
      Object.keys(update).sort().join() !== "evidence,key,value" ||
      typeof update.key !== "string" ||
      !Object.prototype.hasOwnProperty.call(preferenceValues, update.key) ||
      typeof update.evidence !== "string" ||
      !update.evidence.trim() ||
      update.evidence.length > 1000 ||
      (update.value !== null &&
        !(
          preferenceValues[update.key as keyof typeof preferenceValues] as readonly unknown[]
        ).includes(update.value))
    )
      throw invalid();
  }
  return {
    type: "final",
    ...(updates.length ? { memoryUpdates: updates as MemoryUpdate[] } : {}),
    approach: value.approach,
    ...parseTutorOutput(value),
    relatedQuestionIds: Array.isArray(ids) ? [...new Set(ids as number[])] : undefined,
  };
}

export async function generateStructured(
  { system, input, signal, onUsage, onDelta }: TutorModelInput & ModelOptions,
  schema: Record<string, unknown>,
  name: string,
): Promise<unknown> {
  const { client: openai, model, maxOutputTokens } = getClient();
  const body = {
    model,
    instructions: system,
    input,
    store: false,
    max_output_tokens: maxOutputTokens,
    text: { format: { type: "json_schema" as const, name, schema, strict: true } },
  };
  if (onDelta && schema === agentSchema) {
    if (signal?.aborted) throw new TutorServiceError("timeout");
    const stream = await openai.responses
      .create({ ...body, stream: true }, { signal })
      .catch((error: unknown) => {
        if (signal?.aborted) throw new TutorServiceError("timeout");
        throw error;
      });
    const extractor = new StreamedTutorJson((delta) => {
      if (signal?.aborted) throw new TutorServiceError("timeout");
      onDelta(delta);
    });
    let raw = "";
    let textItem: string | undefined;
    let completed = false;
    let refused = false;
    try {
      for await (const event of stream) {
        if (signal?.aborted) throw new TutorServiceError("timeout");
        if (event.type === "response.output_text.delta") {
          const item = `${event.output_index}:${event.item_id}:${event.content_index}`;
          if (textItem !== undefined && textItem !== item)
            throw new TutorServiceError("invalid_output");
          textItem = item;
          extractor.push(event.delta);
          raw += event.delta;
        } else if (
          event.type === "response.refusal.delta" ||
          event.type === "response.refusal.done"
        ) {
          refused = true;
        } else if (event.type === "error") {
          throw new TutorServiceError(tutorFailure(event).code);
        } else if (
          event.type === "response.failed" ||
          event.type === "response.incomplete" ||
          event.type === "response.completed"
        ) {
          const response = event.response;
          if (response.usage)
            onUsage?.({
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            });
          if (refused || response.incomplete_details?.reason === "content_filter")
            throw new TutorServiceError("content_filter");
          if (event.type === "response.failed")
            throw new TutorServiceError(tutorFailure(response.error).code);
          if (event.type !== "response.completed" || response.status !== "completed")
            throw new TutorServiceError("incomplete");
          const finalText = response.output
            .flatMap((item) =>
              item.type === "message"
                ? item.content
                    .filter((content) => content.type === "output_text")
                    .map((content) => content.text)
                : [],
            )
            .join("");
          if (finalText !== raw) throw new TutorServiceError("invalid_output");
          const parsed = extractor.finish();
          // Validate before declaring stream success; callers must discard provisional text on failure.
          parseAgentModelOutput(parsed);
          completed = true;
          return parsed;
        }
        // Provider reasoning, tool-call and other internal events are intentionally ignored.
      }
      throw new TutorServiceError("incomplete");
    } catch (error) {
      if (signal?.aborted) throw new TutorServiceError("timeout");
      if (error instanceof SyntaxError) throw new TutorServiceError("invalid_output");
      throw error;
    } finally {
      if (!completed) stream.controller.abort();
    }
  }
  const response = await openai.responses.create(body, { signal });
  if (response.usage)
    onUsage?.({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
    });
  if (response.status !== "completed") throw new TutorServiceError("incomplete");
  const raw = response.output_text?.trim();
  if (!raw || raw.length > 32_000) throw new TutorServiceError("invalid_output");
  try {
    return JSON.parse(raw);
  } catch {
    throw new TutorServiceError("invalid_output");
  }
}

export async function askTutor(input: TutorModelInput & ModelOptions): Promise<TutorModelOutput> {
  return parseTutorOutput(await generateStructured(input, tutorSchema, "tutor_response"));
}

export async function askTutorAgent(
  input: TutorModelInput & ModelOptions,
): Promise<AgentModelOutput> {
  return parseAgentModelOutput(
    await generateStructured(input, agentSchema, "tutor_agent_decision"),
  );
}
