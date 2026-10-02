# BrainDump.com — Claude certification question coach

An independent Next.js study companion built from the four PDFs in `pdf/`. Choose a certification, attempt a question, ask for conceptual hints, then reveal the source answer and rationale. The optional tutor uses the **Microsoft AI Foundry SDK**; grading and progress are handled by application code and SQLite.

This application is not affiliated with Anthropic and does not provide official live-exam content or guarantee a pass. The original disclaimer from each PDF is retained in the database and displayed on its practice page.

## Run locally

Requirements: **Node.js 22+**, npm, and `pdftotext` on PATH (Poppler; on macOS, `brew install poppler`).

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Development and production builds seed the question bank automatically. The AI tutor is optional; ordinary practice, grading, reveal, and progress work without Azure configuration.

```sh
npm run build
npm start
```

SQLite needs a persistent writable filesystem. Use a single Node application instance for this MVP; do not deploy it to a filesystem that disappears between requests. `EXAMS_DB_PATH` and `LEARNING_DB_PATH` can override the default `data/exams.db` and `data/tutor-sessions.db` locations. Keep both databases and their WAL/SHM files private.

## Foundry setup

See [docs/foundry.md](docs/foundry.md) for the SDK, authentication, and live-evaluation instructions. Copy `.env.example` to `.env.local` only if a local file does not already exist, then configure:

- `FOUNDRY_PROJECT_ENDPOINT`: the HTTPS **project** URL ending in `/api/projects/<project>`.
- `FOUNDRY_MODEL`: an existing model deployment supporting Responses and strict structured output.
- `FOUNDRY_CREDENTIAL=default` for local Azure CLI sign-in, or `managed_identity` on Azure.

The connection uses `AIProjectClient` from `@azure/ai-projects` and Azure Identity. `getOpenAIClient()` is the SDK's project-scoped Responses interface. The former `FOUNDRY_API_KEY` variable is not used: this SDK uses Microsoft Entra ID. The identity requires appropriate project data-plane access. Secrets and SDK clients remain server-side.

## Learning flow

- Draft selections and optional reasoning save automatically. Exact selection counts are enforced for single choice, multiple response, and scenario matching.
- **Submit and reveal** records one immutable, server-graded attempt and shows the PDF answer and rationale. Duplicate submissions do not create extra attempts.
- **Reveal without answering** records exposure but does not count as a scored attempt.
- **Try again** starts a fresh draft. Attempts after seeing an answer are labeled review, even when later answered without hints.
- The coach offers three progressive hint stages, concept explanations, and post-reveal review. Source text remains separate from AI commentary.
- Suggestions prioritize unresolved mistakes, then unattempted questions in the current domain, then other domains in the same certification. The learner chooses when to navigate.
- Progress shows independent first-attempt accuracy with sample counts, assisted attempts, review outcomes, and domain breakdowns. It does not claim an exam-readiness or mastery score.
- The optional 120-minute timer stores an absolute deadline. It survives refresh and continues into review when time expires; coaching remains available throughout.

An opaque HttpOnly cookie identifies the anonymous learner. Progress lasts **30 days from creation** in the same browser; clearing cookies loses access. No account is required. Conversations are limited to 12 stored messages per question and expire after two hours idle or 24 hours total; this does not erase learning progress. Expired records are purged on the next API request. **Reset learning progress** deletes all stored progress and conversations for that browser across certifications. Free-text reasoning and tutor messages are sent to the configured model when coaching is requested; avoid entering personal or confidential information.

## Source integrity

| Certification            | Questions |          Domains |        Time |
| ------------------------ | --------: | ---------------: | ----------: |
| Architect – Professional |        63 |                7 | 120 minutes |
| Architect – Foundations  |        60 | 5; six scenarios | 120 minutes |
| Developer – Foundations  |        53 |                8 | 120 minutes |
| Associate – Foundations  |        60 |                7 | 120 minutes |

The importer reads and validates the title/version, time limit, blueprint, disclaimer, question sequence, answer mappings, and physical PDF page numbers. It preserves stable question IDs and source keys through transactional upserts. Repeated seeding does not erase learning progress. Older malformed child records are reconciled to the source within that transaction and reported.

**Known source discrepancy:** `developer-5.9` requests one answer; its key lists **A, D**, while its rationale supports **C**. All original content is retained and visibly flagged. The question is excluded from scoring and AI coaching, leaving **236 imported questions and 235 scorable questions**. Its disputed source key/rationale can be revealed without scoring. No correction is guessed.

`npm run seed` reports counts, inserts/updates, repairs, and review flags. `node scripts/seed.mjs --strict` fails before database mutation if any question requires source review; it currently fails for the documented Developer discrepancy.

## Commands and verification

| Command                   | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `npm run seed`            | Validate/import PDFs, retaining IDs and reporting source conflicts     |
| `npm run typecheck`       | TypeScript validation                                                  |
| `npm run format:check`    | Check Prettier formatting                                              |
| `npm test`                | Isolated database, API, runtime, provider-contract, and importer tests |
| `npm run test:e2e`        | Chromium integration tests against an isolated local Next.js server    |
| `npm run tutor:eval`      | Check the documented 28-case evaluation contract                       |
| `npm run tutor:eval:live` | Execute 28 model cases plus three hint stages using synthetic content  |
| `npm run tutor:traces`    | Inspect redacted operational metadata                                  |
| `npm run build`           | Import PDFs and build production application                           |

Browser tests use port 3127 and separate databases under ignored `output/playwright/`; install Chromium with `npx playwright install chromium` if needed. Screenshots and retained failure traces are local artifacts. No standalone linter is configured. Prettier checks formatting; TypeScript and the production build validate code. A scoped PostCSS override applies the patched compatible 8.x dependency without a Next.js major upgrade.

Live evaluation incurs Foundry usage and requires valid configuration and Azure access. Output conformance checks are automated; source fidelity, hidden-answer disclosure, and teaching quality require reviewing the saved outputs against their rubrics. Reports always start with human review pending. Offline or mocked tests do not establish live model quality.

## Architecture and interfaces

- `app/`: database-backed pages and Node API handlers; `components/`: client practice UI.
- `lib/db.ts`: public questions and separately scoped source answers.
- `lib/practice.ts`: validation, transactional attempts, grading, progress, and recommendations.
- `agents/ai-tutor/`: bounded model/tool loop, read-only tools, sessions, and evaluation harness.

`GET /api/practice?certification=<slug>` returns drafts, navigation/timer settings, and aggregate progress, with no answer mappings or rationales. Adding `questionId` returns its current state and approved recommendations. `POST /api/practice` accepts `draft`, `submit`, `retry`, `navigate`, or `start`; question mutations validate certification, identifiers, selections, and current revision. `submit` requires a request ID and explicitly reveals the answer. `DELETE /api/practice` resets all learner data and rotates identity.

`POST /api/questions/<id>/answer` explicitly reveals source content; `DELETE` hides it and clears that question's conversation. `POST /api/tutor` accepts a question ID, request ID, current revision, message, and `hint`, `concept`, `review`, or `follow_up` intent. Reveal permissions, selections, reasoning, and hint stage are loaded from server state. `DELETE /api/tutor` clears conversations while preserving learning progress.

Answer keys and rationales are absent from initial HTML, serialized question props, progress responses, and hidden tutor context. Tools enforce reveal permissions. Revisions invalidate responses after hide, retry, navigation, or reset. Withholding private answer keys cannot prevent a model from independently inferring an answer, so adversarial live evaluation remains necessary.

Authentication, cross-device progress, generated exam questions, full lessons, and scheduled study planning remain future work.
