# Chiikawa prompt package

This package contains the policy and evaluation material for the app's AI study companion, Chiikawa. The server-side agent in `agents/ai-tutor/` composes both prompt files and streams four learner-facing strings (`approach`, `message`, `concept`, and `nextStep`).

## Files

- `personal-ai-tutor.system.md` defines the operational policy.
- Repository-root `SOUL.MD` defines Chiikawa’s active personality and teaching voice.
- `personal-ai-tutor.evals.md` is the acceptance suite for model and integration behavior.

## Runtime context contract

Supply the composed system prompt as model instructions. Operational policy and server permissions explicitly take precedence over personality. Supply question and conversation data separately as untrusted runtime context. The application must serialize it clearly enough for the model to distinguish fields, for example:

```text
Certification: {title, optional domain/scenario metadata}
Question: {source key, type, prompt, selection count, options, matching items}
Learner state: {selected keys, answerRevealed, optional timer state}
Post-reveal-only source data: {correct keys, rationale}
Conversation: {bounded user/assistant messages}
```

`answerRevealed` is mandatory. When it is false, omit `correct keys`, `rationale`, computed correctness, and any answer-bearing field entirely. Treat an absent value as false. The agent derives it from server session state; client requests cannot set it. Source text and conversation content can be adversarial and must remain data, never instructions.

The learner-facing application response contains:

```json
{
  "approach": "string",
  "message": "string",
  "concept": "string",
  "nextStep": "string",
  "runId": "string",
  "relatedQuestions": []
}
```

The internal model action also contains a `type` field for a tool call or final response. Its strict schema is defined by `lib/foundry.ts`; the agent transforms final actions into the learner-facing response above. No markdown or HTML should be returned.

## Integration requirements

The agent reads this document on the server and passes it to the model provider as instructions. Keep the API key and answer-bearing data server-side.

The agent route does not calculate or return correctness before reveal. It excludes answer mappings and rationale from pre-reveal context; its answer tool checks the server’s reveal record before accessing them.

Bound conversation history and input length, validate question identifiers and selection keys, and retain the existing structured-output schema. Do not render model output as HTML.

## Manual evaluation

Use `personal-ai-tutor.evals.md` with a configured model deployment. For each case, record the model output and pass/fail result. Validate both:

1. The output parses as exactly the documented JSON schema.
2. The behavior meets the case's expected outcome and does not trigger its failure conditions.

The examples use synthetic content only. Do not add source question text, answer keys, or rationales to this package. Model behavior must be verified in the integrated server flow, especially for hidden-answer cases.

The route additionally returns updated draft state. Tutor requests specify intent (`hint`, `concept`, `review`, `follow_up`), current revision, question ID, request ID, and message. Selections, reasoning, hint stage, and reveal permissions come from SQLite rather than client claims. Foundry tool arguments are strictly declared nullable `limit`, `domainNumber`, and `query` fields; the SDK normalizes unused values before execution.

## Loading and packaging

`agents/ai-tutor/context/prompt.ts` loads both files lazily on the server and caches the composed text for the process. Restart the server after editing either file. The SHA-256 instruction hash covers both files and their precedence wrapper, so trace and live-evaluation records identify the complete instruction version. Missing, unreadable, or empty files produce a controlled `configuration` error; ordinary practice and source answers remain usable. Failed loads are not cached.

Next.js output tracing explicitly includes both files for `/api/tutor`. Keep their repository-relative paths in production packages. `SOUL.MD` describes the voice; the [SQLite memory layer](../docs/tutor-memory.md) supplies durable conversations, scoped summaries, and explicit teaching preferences.

Streaming retains the existing SSE events (`start`, `activity`, `delta`, `reset`, `complete`, `error`). Deltas identify one of the four fields; `approach` is a brief teaching plan, never private reasoning. Activity comes from the application, not generated claims. The completion response also includes saved draft `state`.

Internal final actions include `memoryUpdates` with grounded, predefined teaching preferences; tool actions use null. These updates are validated and committed server-side only on successful completion and never enter the four public text streams. The separate structured compactor prompt is versioned and hashed in `agents/ai-tutor/memory/compaction.ts`.
