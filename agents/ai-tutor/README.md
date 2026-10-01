# AI Tutor agent

This folder contains the server-side AI Tutor agent and its local harness. The agent serves the practice UI through `app/api/tutor`, uses the existing Foundry-compatible Responses API connection, and keeps its anonymous study-session records in `data/tutor-sessions.db`.

## Runtime

`runtime.ts` runs a bounded model → tool → model loop. Each run permits four model calls, six tool calls, one transient provider retry, a 60-second deadline, and a 2,000-token model-output cap. The session store limits learners to one active run and ten new runs per minute.

The tools are deliberately read-only:

- `get_question_context` reads the active question.
- `find_related_questions` returns at most five source-question references from the active certification.
- `get_revealed_answer` is denied unless the server session records a reveal for the active question.
- `get_session_learning_context` returns aggregate evidence from the active anonymous study session.

The agent loads `prompts/personal-ai-tutor.system.md` on the server. It records the prompt hash, timing, model-call count, tool permission decisions, retries, and terminal state. It never writes learner messages, answer data, keys, provider errors, or full prompts into traces. The internal model action selects either a tool call or a final answer; the API exposes only the final learner fields plus a run ID and approved related questions.

## Session and reveal model

The browser receives an opaque `ai_tutor_session` HttpOnly cookie. Conversation is scoped to session plus question and capped at 12 messages. Sessions expire after two hours idle or 24 hours total. Reset removes the session data.

The reveal endpoint is the authority for answer access. A request to hide an answer removes that question’s stored conversation, so post-reveal explanations cannot become hidden-answer context later.

## Harness commands

```bash
npm run tutor:eval       # Validate the documented evaluation suite and its coverage
npm run tutor:traces     # List locally captured, redacted trace metadata
TUTOR_TRACE=1 npm run dev # Write local trace metadata to data/tutor-traces/
```

The evaluator validates the 28 documented cases and the required harness coverage without calling a model. Live model evaluations remain manual: configure `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_API_KEY`, run the app, and record outputs against `prompts/personal-ai-tutor.evals.md`.

## Extension rules

Add a tool only when its arguments, result shape, authorization rule, result size, and trace metadata are defined in code and covered by an evaluation. Keep answer-bearing fields out of pre-reveal model context. Agent code is server-only; client components must use API response types rather than importing this folder.
