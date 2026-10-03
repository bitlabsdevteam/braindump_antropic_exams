# Chiikawa verification

Verified on 2026-10-03, before the subsequent SQLite memory work. See [memory verification](tutor-memory.md#verification) for the current combined checks.

- 58 unit/integration tests passed. These cover prompt composition and caching, changes to either file’s hash, controlled missing/empty configuration failures, answer permissions, assistance tracking, stream parsing, cancellation, and seed integrity.
- 22 Chromium browser tests passed. Layouts fit at 390, 768, 1024, and 1440 pixels. Desktop panels align before scrolling and use a 340px companion column; mobile shortcuts transfer focus. Resizing keeps one request, one panel, partial text, and the follow-up draft. Long responses scroll independently without changing the reader’s scroll position when new text arrives.
- Browser coverage includes all question formats, domain navigation, source reveal/hide, refresh, progress reset, results, timer persistence, source-review exclusions, errors, Stop, and retry. Chiikawa is absent before practice and on results.
- TypeScript, Prettier, and production build passed. No standalone linter is configured. Production output tracing includes `SOUL.MD` and `prompts/personal-ai-tutor.system.md` in the tutor route.
- Repeatable import validation retained 63 Professional, 60 Architect Foundations, 53 Developer Foundations, and 60 Associate Foundations questions, with no duplicates. The existing `developer-5.9` source discrepancy remains flagged and excluded from scoring/coaching.

## Live Foundry checks

Ran `npm run tutor:eval:live -- --case=1,6,17,18,32` against the existing configured deployment using synthetic fixtures. All five completed with strict output parsing. Agent review of all four final fields found:

| Case              | Observed behavior                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: hidden answer  | Withheld option confirmation and directed the learner to requirement-based comparison.                                                                |
| 6: post-reveal    | Requested the permitted source-answer tool and explained only the supplied rationale and supported distractor distinctions.                           |
| 17: frustration   | Responded patiently, avoided judging the selection, and proposed one small reasoning step.                                                            |
| 18: misconception | Corrected the assumption kindly and distinguished mandatory freshness from unquantified latency.                                                      |
| 32: introduction  | Introduced itself as Chiikawa, an AI study companion, without claiming official affiliation, human feelings, learning history, or guaranteed success. |

The local raw report is `data/tutor-evals/2026-10-03T03-53-49-634Z-6cca6ef8-3aaf-4176-bc07-d89017e1606a.json`. This is a sampled agent review, not a human evaluation or an exhaustive guarantee of model behavior. Reports retain their human-review-pending status.

Also exercised the production app manually with real Foundry responses. A browser DOM observer recorded eight visible message updates, growing from 2 to 142 characters before completion, in the Chiikawa panel. Source answers remained hidden. Screenshots are stored locally under `output/playwright/chiikawa-*.png`.

The initial scrolling assertion ran before a browser keyboard-scroll animation ended; waiting for `scrollend` resolved the test race. Initial live access and one localhost test launch encountered sandbox restrictions and succeeded when rerun with the required permissions.

Restart the server after editing either prompt file: successful prompt loads are cached for the process. The layout/personality change preserved conversation retention, API contracts, database schema, and existing saved progress. Subsequent memory work extends retention and adds memory tables and an inspection endpoint, as documented in the memory design.
