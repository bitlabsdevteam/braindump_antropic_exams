# Question coach verification

Verified on 2026-10-02 with Node.js 23.11, Next.js 15.5.26, and the installed Foundry AI Projects SDK 2.7.1.

| Check                         | Result                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| PDF import and repeat import  | 236 questions; all existing question IDs retained; zero duplicate questions                     |
| Source counts                 | Professional 63; Architect Foundations 60; Developer 53; Associate 60                           |
| Content validation            | All supported formats and 25 matching pairs retained; one explicit source discrepancy           |
| `npm test`                    | 23 tests passed, including isolated fresh databases and existing-database import reconciliation |
| `npm run test:e2e`            | 6 Chromium tests passed                                                                         |
| `npm run typecheck`           | Passed                                                                                          |
| `npm run build`               | Passed, including Next.js type/build validation                                                 |
| `npm run format:check`        | Passed                                                                                          |
| `npm run tutor:eval`          | 28 documented cases and four tools wired into the runtime                                       |
| `npm audit --omit=dev`        | Zero reported vulnerabilities after the compatible PostCSS patch override                       |
| `git diff --check`            | Passed                                                                                          |
| Standalone lint               | No standalone linter is configured                                                              |
| Live Foundry smoke evaluation | Configuration blocked; no model request made                                                    |

Browser coverage includes single choice, required-count multiple response, matching selections, hidden initial answers, submission/reveal/hide/retry, refresh persistence, navigation, timer persistence, progress reset, invalid identifiers, provider failure, keyboard activation/focus visibility, mobile width, and discarding a late mocked tutor response after hide. Mobile and desktop screenshots are available locally under ignored `output/playwright/`.

Backend tests verify exact-set grading, immutable/idempotent attempts, assisted versus independent versus review outcomes, stale revision conflicts, source review exclusions, scoped recommendations, thirty-day retention, reset cascades, per-question conversation expiry even after history pruning, forged reveal rejection, run ownership/recovery, transient-only retries, loops, deadlines, and hide/reset/navigation races.

Developer question `developer-5.9` remains explicitly flagged: its select-ONE instruction conflicts with source key A/D and rationale supporting C. The source is preserved and the question excluded from scoring and coaching. `--strict` import validation intentionally fails for that known source discrepancy; normal import reports it and retains all 236 questions (235 scorable).

The existing `.env.local` endpoint is not a project endpoint ending in `/api/projects/<project>`. `npm run tutor:eval:live -- --case=1` stops at configuration validation. Supply the actual project endpoint, deployment name, and an Azure identity with project access before running live checks. SDK/model compatibility, real response quality, and the 31-case behavioral evaluation have therefore not been verified against a deployed model. The live report harness labels human review pending and never converts parser success into a teaching-quality pass.

The app was started against fresh isolated databases using the documented development command by the browser test harness. Production compilation also succeeded against the migrated local bank. No Azure resources were provisioned, credentials changed, or source PDFs replaced.

## Exam completion fix — 2026-10-03

Reproduced the last-question dead end with a failing browser regression: the navigation disabled Next at the final index and never offered a completion action. Individual grades existed, but the practice snapshot had no overall mark and the UI had no results view.

The last question now offers **Finish and view results**. Results are calculated on the server from the first recorded submission for each scorable question, including the last submission. They show total marks, percentage, domain marks, unanswered counts, and assisted/review classifications. Drafts and unscored reveals are not graded; source-review questions remain excluded. Results survive page refresh and offer paths back to review or unanswered questions. Timer expiry and submitting every scorable question also expose a View results action.

Validation: 26 automated tests passed, including complete bank scoring for all four certifications, partial attempts, source-review exclusions, and preserving first marks after retries. All six existing browser checks passed; all six new completion browser checks passed after correcting the test fixtures' request IDs. Full-exam browser cases deliberately submit one wrong answer and verify 62/63, 59/60, 51/52, and 59/60 respectively, followed by result refresh and review navigation. Mobile layout was inspected at 390px width (`output/playwright/exam-results-mobile.png`). TypeScript, formatting, and the production build passed. No standalone linter is configured.
