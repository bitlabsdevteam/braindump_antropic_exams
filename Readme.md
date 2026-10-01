## BrainDump.com

An independent Next.js practice site for the two Claude Certified Architect question sets in `pdf/`.

### Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The `dev` and `build` commands run the PDF importer first, so the SQLite database is created or refreshed automatically.

### Useful checks

```bash
npm run seed       # Parse both PDFs and rebuild data/exams.db
npm run typecheck  # TypeScript validation
npm run build      # Production build
```

The importer currently validates and loads four exam sets: 63 Architect Professional questions, 60 Architect Foundations questions, 53 Developer Foundations questions, and 60 Associate Foundations questions. `data/exams.db` is local generated state and is intentionally ignored by git.

### Scoring

Each source question is worth 1 mark, so each exam’s maximum score equals its question count. A question earns its mark only when the answer is exactly correct; multiple-response and scenario-matching questions do not receive partial credit. The practice view shows earned marks, attempted questions, and accuracy as answers are revealed.

All four source papers recommend 120 minutes. Each practice set lets the learner choose either a 120-minute countdown to mimic the exam or an untimed study mode before starting.

This is independent practice content, not official live-exam content. Authentication and saved learner accounts are future scope.

### AI Tutor

Copy `.env.example` to `.env.local` and set `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_API_KEY` for a Microsoft Foundry project. The AI Tutor agent calls the project Responses API with the `FOUNDRY_MODEL` deployment, which defaults to `gpt-6-astra`. Its server-side harness manages bounded tool calls, anonymous session-only study memory, answer-reveal permissions, retries, and redacted local traces. The API key stays server-side and no account is required. Rotate the key regularly and never commit `.env.local`.

```bash
npm run tutor:eval    # Validate the agent’s evaluation contract and tool wiring
npm run tutor:traces  # View local redacted trace metadata
```

See [`agents/ai-tutor/README.md`](agents/ai-tutor/README.md) for the agent architecture, trace setting, and extension rules.

Manual smoke test:

1. Configure a Foundry deployment named `gpt-6-astra` (or set `FOUNDRY_MODEL`) and add the project API key to `.env.local`.
2. Run `npm run dev`, open a practice set, choose untimed study, and select an answer.
3. Click **Ask AI Tutor** before revealing the official answer. Confirm the response is concept-level and does not name the answer.
4. Reveal the answer, ask a follow-up, and confirm the tutor can explain the rationale. Use keyboard focus to open, close, type, retry, and submit the panel.
# braindump_antropic_exams
# braindump_antropic_exams
