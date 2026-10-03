# Question coach verification

Verified on 2026-10-03 with Node.js 23.11, Next.js 15.5.26, AI Projects SDK 2.7.1, and OpenAI SDK 6.49.0 connected to Microsoft Foundry.

| Check                        | Result                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PDF import and repeat import | 236 questions, stable IDs, no duplicates or validation errors; one preserved source discrepancy                                          |
| Source counts                | Professional 63; Architect Foundations 60; Developer 53; Associate 60                                                                    |
| `npm test`                   | 55 passed                                                                                                                                |
| `npm run test:e2e`           | 16 Chromium tests passed                                                                                                                 |
| `npm run typecheck`          | Passed                                                                                                                                   |
| Production build             | Passed with `NEXT_DIST_DIR=output/production-check npm run build`                                                                        |
| `npm run format:check`       | Passed                                                                                                                                   |
| `npm run tutor:eval`         | 28 documented cases and four tools wired into the runtime                                                                                |
| Dependency install audit     | Zero reported vulnerabilities                                                                                                            |
| `git diff --check`           | Passed                                                                                                                                   |
| Standalone lint              | No standalone linter configured                                                                                                          |
| `npm run tutor:check`        | Real structured response passed; initial check took 2.2 seconds                                                                          |
| Live synthetic cases         | 30 completed with valid structured responses; one rejected by Foundry's content filter                                                   |
| Live browser                 | Hints, concept explanations, follow-ups, single-choice review, multiple-response review, and five-pair matching review returned HTTP 200 |

## Tutor connection and recovery fixes

The original configuration placed a resource `/openai/v1` URL in `FOUNDRY_PROJECT_ENDPOINT` and supplied an API key, while the application required a project URL and Entra credentials. Validation failed before any model request. Azure CLI discovery also confirmed that the cached sign-in had no accessible subscriptions. The configured resource and key were usable directly.

The application now retains AI Projects SDK support for project endpoints and adds Microsoft's documented OpenAI SDK connection for Foundry resource v1 endpoints. Local configuration was moved to `FOUNDRY_OPENAI_ENDPOINT` with `FOUNDRY_CREDENTIAL=api_key`, preserving the existing resource, model deployment, and key. No cloud resources or role assignments were changed. The SDK is always given the explicit Azure endpoint.

A valid tool sequence could previously consume all four model calls without leaving a final response. Production now reserves the last call for a final answer, labels tool results consistently with evaluation, and returns only references actually supplied by the recommendation tool. Failed requests no longer persist user messages or learning credit. Older incomplete conversation turns are excluded from future model context without deleting valid exchanges or practice progress.

The live browser initially encountered a provider timeout, then succeeded on retry. This exposed another defect: real SDK connection-error classes keep `name` equal to `Error`, so name-only retry checks did not recognize them. Tests now exercise the real SDK classes; bounded retries and timeout diagnostics work with those classes. The app reports safe categories for configuration, authentication, deployment, service filtering, rate limits, timeout, and malformed output. Raw provider messages and credentials are not returned or logged. Resource requests explicitly disable Next.js fetch caching.

The running dev server was restarted after a stale compiled-module error. Browser tests now use a separate build directory, preventing test servers from overwriting the running application's generated files. Generated verification output is excluded from normal TypeScript source discovery.

## Live evidence and limits

The three local evaluation artifacts below cover all 31 synthetic cases. Thirty produced valid structured responses. Case 22 (a request for private instructions and the answer key) was rejected by the service with HTTP 400 `content_filter`; it remains recorded as an error with no invented model response and no parser pass. The evaluation command exits nonzero for that case, while continuing unrelated cases. In the real browser's existing conversation, the corresponding request instead received an explicit model refusal with no hidden answer disclosure.

- `data/tutor-evals/2026-10-03T01-40-14-002Z-712c7f48-8a0d-4e93-9308-b639c1a67eb7.json`
- `data/tutor-evals/2026-10-03T01-42-58-133Z-01727087-d924-4e5e-b25b-f60077ba8d99.json`
- `data/tutor-evals/2026-10-03T01-47-44-298Z-27c20cf5-f5ad-429c-9757-9dfeea85a58f.json`

Responses were inspected for hidden-answer disclosure, source alignment, progressive hints, and format-specific explanations. The matching review explained all five real source pairings, including reuse of the same option, and the multiple-response review matched the two source selections. A mobile review screenshot was inspected at 390px width with no horizontal overflow: `output/playwright/tutor-live-matching.png`. The harness deliberately retains `humanReview: pending`: valid JSON is not a blanket teaching-quality pass. Live project/Entra access was not available in this account; its exact SDK URL, token audience, authorization, parsing, and retry behavior are covered by transport tests. Live resource/key access was verified through the SDK and the browser.

Backend regressions cover all answer formats, immutable grades, reveal permissions, stale/reset/navigation races, retries, deadlines, loop limits, recovery after rejected messages, legacy orphan turns, and safe diagnostics. Browser regressions cover scoring, source reveal/hide, navigation and refresh, timer behavior, keyboard controls, mobile width, missing configuration, and all four certification results. A scan of 37 generated client files found no configured API key.

Developer question `developer-5.9` remains flagged: its select-ONE instruction conflicts with source key A/D and rationale supporting C. It is preserved and excluded from scoring/coaching, leaving 235 scorable questions. No source PDFs were changed.

## Exam completion fix — 2026-10-03

Reproduced the last-question dead end with a failing browser regression: the navigation disabled Next at the final index and never offered a completion action. Individual grades existed, but the practice snapshot had no overall mark and the UI had no results view.

The last question now offers **Finish and view results**. Results are calculated on the server from the first recorded submission for each scorable question, including the last submission. They show total marks, percentage, domain marks, unanswered counts, and assisted/review classifications. Drafts and unscored reveals are not graded; source-review questions remain excluded. Results survive page refresh and offer paths back to review or unanswered questions. Timer expiry and submitting every scorable question also expose a View results action.

Validation: 26 automated tests passed, including complete bank scoring for all four certifications, partial attempts, source-review exclusions, and preserving first marks after retries. All six existing browser checks passed; all six new completion browser checks passed after correcting the test fixtures' request IDs. Full-exam browser cases deliberately submit one wrong answer and verify 62/63, 59/60, 51/52, and 59/60 respectively, followed by result refresh and review navigation. Mobile layout was inspected at 390px width (`output/playwright/exam-results-mobile.png`). TypeScript, formatting, and the production build passed. No standalone linter is configured.

## Foundry response streaming — 2026-10-03

The SDK now requests genuine Responses streaming. A bounded incremental JSON parser forwards only learner-facing approach, explanation, concept, and next-step text; provider reasoning events and raw tool payloads remain private. The API emits server-sent events, and the browser renders incoming chunks directly with activity updates and a Stop control. Completed output is validated before conversation persistence. Cancellation, failure, retries, and stale question revisions clear provisional UI text. A partial pre-reveal hint records assistance without advancing hint stage or persisting an incomplete exchange.

Live verification through the running Next.js route and configured Foundry resource returned 66 text deltas across all four fields. The first delta arrived at 5.823 seconds and the completed reply at 8.829 seconds, confirming that text was delivered before completion. The temporary verification learner was deleted afterward. This timing is one observed request, not a latency guarantee.

Provider transport regressions cover split Unicode/JSON, internal-event filtering, refusal, invalid output, cancellation, and early deltas. Browser regressions gate individual chunks to verify visible partial output before completion, Stop and late output, re-hiding the source, retry/error rollback, focus behavior, and mobile width. Server tests verify immediate run release on cancellation, safe terminal errors, no incomplete transcript persistence, stale-delta rejection, and correct assistance classification after a stopped hint.

Final streaming validation: all 55 unit tests, all 16 Chromium tests, TypeScript, formatting, and the production build passed. The initial type check identified a missing `relatedQuestions` field in a new server-stream test fixture; it was corrected and the check rerun successfully. No standalone linter is configured.
