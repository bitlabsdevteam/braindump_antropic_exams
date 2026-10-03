# Chiikawa memory and context compaction

Chiikawa now keeps completed conversation history in SQLite and uses it across requests, refreshes, process restarts, and periods of inactivity. Reusable teaching preferences also follow the anonymous learner across questions. The memory expires with the existing 30-day learner identity; it is not shared with other learners.

## OpenAI guidance and implementation choice

This implementation adapts the production patterns documented in:

- [Building Reliable Agents with Memory and Compaction](https://developers.openai.com/cookbook/examples/agents_sdk/building_reliable_agents_memory_compaction): separate reusable memory from active working context, compact at thresholds/boundaries, preserve provenance, and keep authoritative artifacts separate.
- [Context Engineering — Short-Term Memory Management with Sessions](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory): retain recent complete turns, summarize older turns into structured working state, preserve corrections and uncertainty, bound context, and evaluate summary drift and recall.

These are implementation guidelines, not a formal certification standard. This TypeScript application retains its existing Microsoft Foundry Responses provider and server-owned SQLite sessions. It uses application-managed structured summarization rather than the OpenAI Python SDK or opaque `/responses/compact` items. The application must be able to inspect summaries and strictly separate hidden-answer and revealed-answer history. No new provider account or hosted memory service is required.

## Storage and migration

`LEARNING_DB_PATH` still selects the learner database (default `data/tutor-sessions.db`). Additive migration 3 in `agents/ai-tutor/memory/schema.ts` creates:

| Table               | Purpose and provenance                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tutor_turns`       | One complete user/assistant exchange, stable source question key, server-owned reveal phase, unique request ID, actual tool outcomes, prompt hash, and timestamp.                       |
| `tutor_summaries`   | One current checkpoint per learner/question/reveal phase: structured summary, covered-through turn ID, version, input digest, compactor prompt/policy hash, byte counts, and timestamp. |
| `tutor_preferences` | Latest explicit teaching preferences, linked to the source turn and an exact quotation from the learner. Only predefined values can be stored.                                          |

```text
sessions ──1:N── tutor_turns ──1:N── tutor_preferences (evidence)
   │                 │
   └──1:N── tutor_summaries ──N:1── covered-through turn
```

Foreign keys cascade learner deletion to all memory. Checkpoints cannot reference a turn from another learner, question, or reveal phase. Preferences cannot encode arbitrary instructions or answer text. Migration is transactional and idempotent; existing question-bank and grading tables are unchanged. The explicit `rollbackMemory(database)` function drops only the new memory tables and migration marker. It is operator-only and never runs during application startup; revert the application version as part of a rollback. Unit tests exercise both migration and rollback.

The previous `messages` table remains a short-lived compatibility cache. On first use, only complete pairs from its still-valid question history are imported, retaining their timestamps and a `legacy-unknown` prompt marker. Orphan assistant messages and incomplete/failed user turns are excluded. Messages already deleted by the previous implementation cannot be recovered.

## Runtime flow

1. Validate the anonymous session, active question, source-review status, revision, and reveal permissions. Acquire the existing per-learner run lock.
2. Load saved teaching preferences and the current question’s history for the **current reveal phase**. Load any existing summary checkpoint.
3. If uncovered history exceeds eight turns or 12,000 UTF-8 bytes, summarize complete older turns while retaining the latest three turns verbatim. Process at most one bounded batch per request; an older backlog remains archived and is explicitly reported as omitted working context until later checkpoints cover it.
4. The compactor receives the previous summary plus the next source turns. It returns a goal, up to four evidence-linked learning notes, up to three open questions, and one next step. It must preserve uncertainty and newer corrections. Each note cites at most eight valid source IDs. Validate the schema, field lengths, evidence IDs, size reduction, and current run/revision before atomically advancing the checkpoint with a version check.
5. Supply the summary, saved preferences, and bounded recent complete pairs to the tutor as **untrusted contextual data**, separate from system instructions and the current learner message. A summary never establishes source correctness or reveal permission.
6. The tutor can use `search_conversation` to recover an older detail from the archive. Search is parameterized and restricted to this learner, this question, and its current reveal phase. It returns at most three matching turns with explicitly marked excerpts, bounded to 2,400 assistant characters each.
7. Only a validated, completed response commits its exchange and grounded preference updates, atomically with existing assistance tracking. Partial, cancelled, stale, and failed responses do not become durable memories. A checkpoint can persist independently because it summarizes previously completed exchanges.

The four public streamed fields remain `approach`, `message`, `concept`, and `nextStep`. Internal `memoryUpdates` never enter browser deltas or the public reply. Actual memory lookup, compaction, and history-search activity appears in the panel.

## Budgets and failure behavior

- Default deployment context capacity: `FOUNDRY_CONTEXT_WINDOW_TOKENS=128000`; configure it to the actual deployment capacity (accepted range 32,768–1,048,576).
- Reserve `FOUNDRY_MAX_OUTPUT_TOKENS` (default 4,096) plus 4,096 tokens of schema/wire headroom.
- Treat UTF-8 bytes as a conservative upper bound on text tokens; cap the assembled instructions/input at 96,000 bytes or the smaller configured input budget.
- Recent working history is capped at 24,000 bytes. Drop whole oldest pairs if the full request still exceeds budget. Preserve the complete question and operational prompt; fail with a controlled `context_limit` error if those and required tool context alone cannot fit.
- Each compaction batch is at most 48,000 input bytes and also respects the deployment budget. Summaries are at most 8,000 bytes, with tighter per-field limits.
- One compaction call may use up to 25 seconds inside the existing 60-second overall deadline. The tutor retains at most four calls, three tool calls, and one transient retry. Even a compactor that ignores cancellation cannot block beyond the deadline.

Compaction failure preserves the archive and last valid checkpoint, uses bounded recent context, emits a truthful unavailable activity, and sets `omittedOlderTurns` when relevant. Chiikawa must acknowledge incomplete recall rather than invent missing details. Navigation, hide, retry, forgetting, expiry, or reset invalidates an in-flight checkpoint/response; stale work cannot recreate deleted memory. Traces record counts, hashes, source ranges, size reduction, latency, usage, and safe error categories—not raw conversation text or provider errors.

## Reveal boundaries and learner control

Hidden-answer history and revealed-answer history have separate checkpoints and separate retrieval paths. Hiding an answer immediately excludes all revealed-answer memory from the model, search tool, and history API. Old revealed conversations remain stored until forgotten/expired and become available only after a new explicit reveal. This avoids sending previously revealed answers back into hidden-answer coaching.

Only closed-list teaching preferences cross question boundaries: depth, style, language, and experience. A model can propose updates only with an exact quotation from the **current** learner message. The server validates the value and evidence before saving; newer explicit values supersede older ones. Neither past assistant output nor source question text can update preferences. Saved preferences and the current message govern the continuing style; removed preferences must not be reinstated from old summaries or conversations.

The **Memory & conversation history** control in Chiikawa’s panel loads a paginated history view on demand. Learners can forget individual preferences or all conversations, summaries, and preferences while keeping grades. The history inspector cancels stale fetches on question/reveal changes. `DELETE /api/tutor/memory` validates origin and identifiers and invalidates active runs. The existing `DELETE /api/tutor` also clears memory. **Reset learning progress** deletes everything for the learner, including grades. Expired sessions and their memory are purged on the next API request.

## Verification

`npm test` exercises durable process-to-process storage, idempotent migration/rollback, whole-turn compaction, checkpoint reuse and merging, preservation of an early learning goal, scoped archive search, evidence validation, cross-question preferences, isolation across learners/reveal phases, context budgets, unavailable compaction, stale writes, cancellation, forgetting, expiry, and non-persistence of partial responses. Browser tests cover history inspection, refresh, mobile layout, reveal/hide races, preference deletion, and preserving grades after forgetting.

Run `npm run tutor:memory:live` with the existing Foundry configuration for real preference extraction, structured compaction, same-question recall, and cross-question adaptation. It creates an isolated SQLite database and an incremental report under ignored `output/chiikawa-memory/`; it does not use a learner’s actual records. Filler conversations are labeled synthetic to exercise compaction without unnecessary model calls. Review the resulting summary, evidence IDs, teaching behavior, and hidden-answer boundaries. Output validity alone is not a semantic recall or safety guarantee.

### Verified results — 2026-10-03

- All 74 unit/integration tests passed, including 16 memory tests. TypeScript, Prettier, and the production build passed. No standalone linter is configured. Production tracing includes both prompt files.
- All 24 Chromium browser tests passed. They cover the memory inspector, refresh, reveal/hide races, forgetting while preserving grades, all question formats, domain navigation, results, source-review exclusions, streaming cancellation, and layouts at 390, 768, 1024, and 1440 pixels. The mobile memory screenshot was visually reviewed; long content remains within the panel’s scroll area.
- The live memory harness completed three real Foundry responses. It saved the requested brief/example/beginner preferences, recalled the earlier input-context versus output-limit confusion after compaction, and applied preferences on a different question. The checkpoint reduced 5,967 input bytes to a 787-byte summary; all 15 completed exchanges remained archived. The summary cited existing turns and explicitly retained uncertainty about the learner’s understanding.
- Agent review of live coaching cases 1, 6, 17, 18, and 32 found the hidden answer withheld, permitted source explanations used after reveal, patient encouragement, a kind misconception correction, and Chiikawa’s expected introduction. These are sampled agent reviews, not human evaluation or exhaustive guarantees; reports retain their human-review-pending status.

Local reports: `output/chiikawa-memory/1791002253001-abc04fc1-a9f6-44b5-b8ff-daeb5db6b8dc/report.json` and `data/tutor-evals/2026-10-03T04-40-42-930Z-54ca0453-7fa1-4095-b7dc-7ffeffc93dfe.json`.

An initial live compaction failed validation because one note cited nine turns where the validator allowed eight. The prompt and native output schema now express the same eight-ID limit; the successful run above used that fix. Initial browser history checks had incorrect exact-text selectors, corrected without changing application behavior. Sandbox network/port failures were rerun with the required permissions.
