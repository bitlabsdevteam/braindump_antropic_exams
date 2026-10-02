# AI question coach

The tutor uses the Microsoft Foundry AI Projects SDK and runs inside the Next.js server. See [Foundry setup](../../docs/foundry.md) for project endpoints, Entra authentication, deployment requirements, and evaluation instructions.

## Runtime and permissions

Each request permits four model calls, six tool calls, one transient retry, a 60-second wall-clock deadline, and at most 2,000 output tokens per model call. SDK retries are disabled. Learners have one active run and ten new runs per minute; runs abandoned for more than 70 seconds can be reclaimed. Request IDs prevent duplicate execution.

Read-only tools:

- `get_question_context`: active public question only.
- `find_related_questions`: up to three deterministic references in the active certification; flagged source questions are excluded.
- `get_revealed_answer`: source answer and rationale only while server state permits reveal.
- `get_session_learning_context`: recorded independent attempt aggregates for this certification; excludes the active question.

Inputs include server-owned selections, optional reasoning, teaching intent, hint stage, reveal permission, revision, and bounded history. The model chooses a strictly validated tool action or final response. The public response retains `message`, `concept`, `nextStep`, `runId`, and approved `relatedQuestions`; the route adds the updated draft state. All AI text is rendered as text, never HTML.

## Persistence

`data/tutor-sessions.db` contains the anonymous 30-day learner identity, immutable attempts, drafts, exposure/assistance, navigation/timer settings, and short-lived messages. Tables use foreign keys with cascade deletion. Question references use stable source keys, validated against the question bank when accessed. Source bank and learner database are separate files; there is no cross-file SQLite foreign key.

Conversations expire after two hours idle or 24 hours total and retain at most 12 messages per question. Hiding an answer deletes that question's conversation. Navigation, hide, retry, and reset invalidate in-flight runs through revisions. Run ownership prevents a rejected duplicate request from releasing another request's lock. Resetting learning progress deletes all learner data; resetting tutor conversation preserves attempts.

Before reveal, neither source mappings, rationale, nor active-question correctness reaches the model. Successful pre-reveal help records assistance; hint requests advance through three conceptual stages. After reveal, the source answer tool supplies authoritative content. Source conflicts are excluded from coaching.

## Verification and traces

```sh
npm test
npm run tutor:eval
npm run tutor:eval:live -- --case=1,6,12
TUTOR_TRACE=1 npm run dev
npm run tutor:traces
```

Offline tests exercise actual API/data/runtime behavior with isolated databases and mocked model decisions. The documented-coverage command does not invoke a model. The live harness executes synthetic cases, writes incremental reports to `data/tutor-evals/`, and leaves behavioral review pending. Do not equate parser success with passing teaching or disclosure evaluations.

Optional traces under `data/tutor-traces/` record prompt hash, timing, call counts, token usage, tool permissions, retries, and terminal state. They omit learner messages, answers, credentials, full prompts, and raw provider errors. Keep this directory private and rotate/delete trace files as needed; learner reset affects learner records, not redacted operational traces.
