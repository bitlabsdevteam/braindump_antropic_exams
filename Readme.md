# BrainDump.com — Claude Certification Practice

BrainDump.com is an independent study companion for people preparing for Claude certification exams. It turns the supplied certification question banks into a focused browser-based practice experience: choose a certification, work through questions, submit or reveal an answer, and use the rationale to understand the decision behind it.

The goal is deliberate practice rather than memorization. Learners can study without a clock, or opt into the 120-minute time limit used by the source exam papers when they want to rehearse exam conditions.

> **Important:** BrainDump.com is independent practice content. It is not an official Anthropic product, is not affiliated with Anthropic, and does not provide official live-exam questions or guarantee a passing result. Use it alongside the official certification information, documentation, and hands-on experience.

## What is included

The current question bank contains four certification tracks imported from the PDFs in [`pdf/`](pdf/):

| Certification | Questions | Domains | Recommended time |
| --- | ---: | ---: | ---: |
| Claude Certified Architect – Professional | 63 | 7 | 120 minutes |
| Claude Certified Architect – Foundations | 60 | 5 | 120 minutes |
| Claude Certified Developer – Foundations | 53 | 8 | 120 minutes |
| Claude Certified Associate – Foundations | 60 | 7 | 120 minutes |

The application preserves the source order and supports the question formats represented in the source material:

- **Single choice:** select one answer.
- **Multiple response:** select the required number of answers.
- **Scenario matching:** match each numbered item to one of the available options.

Questions retain useful study metadata such as certification, domain, scenario where applicable, source key, and source file reference. Answers remain hidden until the learner submits or explicitly reveals them. Once revealed, the practice view shows the correct answer and the source rationale.

## Why this project exists

Certification preparation is most useful when it helps a learner explain *why* an answer is correct. BrainDump.com is designed to support that loop:

1. Pick the certification track that matches your goal.
2. Choose untimed study or a 120-minute practice session.
3. Read each prompt carefully and submit your own answer before revealing the key.
4. Compare your reasoning with the answer and rationale.
5. Move between questions using the progress indicator and revisit uncertain areas.

The app is intentionally lightweight. It does not require an account, collect personal information, or depend on a hosted database. Authentication, saved learner history, and account-based progress can be added later without making them prerequisites for the core practice flow.

## Features

- Certification landing page populated from the SQLite database.
- Practice views with progress, question navigation, and responsive layouts.
- Untimed study mode and optional 120-minute countdown mode.
- Input controls appropriate to each question type: radio buttons, checkboxes, and matching selectors.
- Validation that prevents incomplete or impossible submissions.
- Reversible answer reveal with correct options and rationale.
- Score, attempted-question, and accuracy indicators during a practice session.
- Server-side SQLite access so answer mappings are not included in the learner-facing question payload before reveal.
- Deterministic PDF importer with repeatable database seeding and source-count validation.
- Optional server-side AI Tutor integration through Microsoft Foundry.

## Technology

- [Next.js](https://nextjs.org/) 15 with the App Router
- TypeScript
- React 19
- SQLite through `better-sqlite3`
- Plain CSS for the editorial visual system
- `pdftotext` for extracting the supplied PDF question banks
- Microsoft Foundry Responses API for the optional AI Tutor

## Run locally

### Requirements

- Node.js compatible with the installed Next.js version
- npm
- `pdftotext` available on your PATH for importing the supplied PDFs

On macOS, `pdftotext` is commonly installed through Poppler. Confirm it is available with:

```bash
pdftotext -v
```

### Install and start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The development command runs the importer first, so `data/exams.db` is created or refreshed before Next.js starts.

For a production-style local run:

```bash
npm run build
npm run start
```

## Project commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Import the PDFs and start the Next.js development server. |
| `npm run build` | Import the PDFs and create an optimized production build. |
| `npm run start` | Start the previously built production application. |
| `npm run seed` | Rebuild the local SQLite question bank from the PDFs. |
| `npm run typecheck` | Run TypeScript validation without emitting files. |
| `npm run tutor:eval` | Validate the AI Tutor evaluation contract and tool wiring. |
| `npm run tutor:traces` | Inspect redacted local Tutor trace metadata. |

There is currently no separate lint script configured. The production build includes Next.js lint/type validation for the configured project.

## Data import and integrity

The source PDFs are the content authority. The importer in [`scripts/seed.mjs`](scripts/seed.mjs) extracts question text, options, question type, domain/scenario metadata, answer mappings, and rationales, then writes normalized records to `data/exams.db`.

Running `npm run seed` is intentionally repeatable. The importer recreates the certification/question data so it does not accumulate duplicate rows across runs. It also checks that:

- Every expected source question has an answer mapping.
- Every answer maps to an available option or matching item.
- Supported question types are represented explicitly.
- Source keys remain unique.
- The imported question counts match the current source sets.

The generated database is local state and is ignored by Git. Do not manually edit it as a substitute for correcting the source extraction logic. If a PDF changes or an extraction is ambiguous, update the importer and review the resulting records against the source PDF.

## Data model

The database separates exam metadata from question content and answer data. The main tables are:

- `certifications` — title, description, source file, question count, time limit, and disclaimer.
- `domains` — certification domain numbers and names.
- `scenarios` — scenario metadata for scenario-based source sets.
- `questions` — stable source key, order, type, prompt, selection count, and source metadata.
- `options` — selectable answer options for ordinary questions.
- `match_items` — numbered prompts for scenario-matching questions.
- `answers` — structured correct keys and rationale, kept separate from the learner-facing question query.

This separation leaves room for future features such as filters by domain or question type, learner sessions, saved progress, and more detailed performance reporting.

## Optional AI Tutor

The AI Tutor is an optional server-side study assistant. It can provide concept-level guidance before the official answer is revealed and explain the rationale after reveal. It is not required to use the question practice experience.

To configure it, copy the example environment file and add credentials for a Microsoft Foundry project:

```bash
cp .env.example .env.local
```

Set the values described in `.env.example`, including:

- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_API_KEY`
- `FOUNDRY_MODEL` (optional; defaults to the configured project deployment)

The API key is used only on the server. Never commit `.env.local` or place credentials in client-side code. See [`agents/ai-tutor/README.md`](agents/ai-tutor/README.md) for the Tutor architecture, evaluation harness, privacy boundaries, and trace settings.

## Privacy and security

- No login or personal information is required for the MVP.
- The local SQLite database contains practice content, not learner accounts.
- `.env.local`, credentials, generated databases, and build output are excluded from source control.
- Imported PDF text is rendered as text and is not treated as executable HTML.
- Answer data is accessed through server-side code and reveal endpoints rather than being sent with the initial question list.
- Any future account or session work should preserve least-privilege data access and explicit validation of route parameters and database inputs.

## Repository layout

```text
app/                  Next.js routes, pages, and API handlers
components/           Interactive practice and shared UI components
lib/                  Server-side database access and shared types
scripts/seed.mjs      Deterministic PDF importer and SQLite seed script
pdf/                  Source certification PDFs
data/                 Generated local SQLite database (ignored by Git)
agents/ai-tutor/      Optional AI Tutor implementation and harness
prompts/              Tutor prompts and evaluation notes
```

## Verification checklist

Before submitting changes, run:

```bash
npm run seed
npm run typecheck
npm run build
```

Then manually confirm that:

- All four certification cards appear on the landing page.
- A single-choice, multiple-response, and scenario-matching question render correctly.
- Answers are hidden initially and reveal with rationale only when requested.
- Invalid certification slugs produce a safe not-found state.
- Navigation and progress remain correct when moving through a practice set.
- The interface is usable with keyboard controls and on narrow screens.

## Contributing

Keep changes focused on the practice experience and preserve source fidelity. Do not silently rewrite or discard source question text, options, answer keys, or rationales. When the PDF extraction is unclear, flag the item for review and keep the source PDF as the authority.

Please do not add official branding, imply Anthropic affiliation, or describe this project as an official exam simulator. New features should remain optional and should not require authentication, hosted infrastructure, or a paid service for the core learner flow.

## Disclaimer

BrainDump.com is an independent educational practice tool. Certification names and related marks belong to their respective owners. The questions and explanations in this repository are provided for study purposes and may not reflect the current live exam. Always check the official certification resources for the latest exam policies, objectives, and preparation guidance.
