# Personal AI Tutor prompt package

This package contains the policy and evaluation material for the app's personal certification tutor. The server-side agent in `agents/ai-tutor/` loads this prompt and returns the three learner-facing strings (`message`, `concept`, and `nextStep`).

## Files

- `personal-ai-tutor.system.md` is the complete system instruction to load server-side.
- `personal-ai-tutor.evals.md` is the acceptance suite for model and integration behavior.

## Runtime context contract

Supply the system prompt as model instructions. Supply question and conversation data separately as untrusted runtime context. The application must serialize it clearly enough for the model to distinguish fields, for example:

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

The route additionally returns updated draft state. Tutor requests specify intent (`hint`, `concept`, `review`, `follow_up`), current revision, question ID, request ID, and message. Selections, reasoning, hint stage, and reveal permissions come from SQLite rather than client claims. Foundry tool arguments are strictly declared nullable `limit` and `domainNumber` fields; the SDK normalizes unused values before execution.
