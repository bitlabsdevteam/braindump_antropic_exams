# Certification scoring and the live practice estimate

Verified online on October 4, 2026. The official [Claude partner page](https://claude.com/partners) links to the [Anthropic Partner Academy certification catalog](https://anthropic-partners.skilljar.com/page/partner-certifications), which links to the FAQ and all four guides below.

## Official facts

The [certification FAQ, “How is the exam scored, and what's the passing bar?”](https://anthropic-partners.skilljar.com/page/faq-certifications) states:

> Results are reported as a scaled score of 100 to 1,000. The minimum passing score is 720 for all four certifications. Scaled scoring equates scores across exam forms that may have slightly different difficulty.

The current exam guides also confirm the scale and cut score:

| Certification            | Official guide                                                                                                                                                                                            | Scoring section          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Architect – Professional | [Exam guide](https://everpath-course-content.s3-accelerate.amazonaws.com/instructor%2F6nizmqk8tpzpfjvt6qmmav7rh%2Fpublic%2F1783542810%2FClaude+Certified+Architect+%E2%80%93+Professional+Exam+Guide.pdf) | Section 9, PDF page 8    |
| Architect – Foundations  | [Exam guide](https://everpath-course-content.s3-accelerate.amazonaws.com/instructor%2F6nizmqk8tpzpfjvt6qmmav7rh%2Fpublic%2F1783542750%2FClaude+Certified+Architect+%E2%80%93+Foundations+Exam+Guide.pdf)  | Section 10, PDF page 33  |
| Developer – Foundations  | [Exam guide](https://everpath-course-content.s3-accelerate.amazonaws.com/instructor%2F6nizmqk8tpzpfjvt6qmmav7rh%2Fpublic%2F1783542875%2FClaude+Certified+Developer+%E2%80%93+Foundations+Exam+Guide.pdf)  | Section 9, PDF page 11   |
| Associate – Foundations  | [Exam guide](https://everpath-course-content.s3-accelerate.amazonaws.com/instructor%2F6nizmqk8tpzpfjvt6qmmav7rh%2Fpublic%2F1783542847%2FClaude+Certified+Associate+%E2%80%93+Foundations+Exam+Guide.pdf)  | Section 9, PDF pages 7–8 |

The guides describe a criterion-referenced standard, total scaled score determining pass/fail, and domain percentages supplied for feedback. They do not supply a raw-to-scaled conversion formula or exam-form calibration data. **720 is not evidence of a 72% raw accuracy requirement.** The portal cannot reproduce official scaled scores or predict a pass from this practice bank.

## Portal calculation

The portal uses a transparent **linear practice approximation**, not an Anthropic scoring algorithm:

- **Current practice score estimate:** `floor(100 + 900 × correct / submitted)`, using one first submitted attempt per scorable question. No attempts displays “—”; one wrong answer displays 100, one correct answer displays 1,000, and one correct of two displays 550. The UI gives sample counts, raw accuracy, and a provisional label while questions remain unanswered.
- **Full-bank estimate:** `floor(100 + 900 × correct / total_scorable)`. Unanswered questions earn no marks. This begins at 100 and equals the current estimate after all scorable questions are submitted. If no scorable questions exist, it is unavailable.
- **720 reference:** compare the current estimate with the verified official cut score, using “at or above” / “below the reference,” never an official pass/fail verdict. Integer scores round down so rounding cannot promote an estimate across the reference.
- Every question carries one mark. Multiple response and matching require the complete exact answer set; no partial credit. This preserves the portal's existing grading, rather than claiming an official item-weight or partial-credit rule.
- Wrong answers count as submitted. Drafts, navigation, and reveal without submission do not. Retries never replace the first mark. Existing assisted and post-reveal first attempts remain included and their counts are disclosed.
- The disputed `developer-5.9` stays excluded: totals are 63, 60, 52, and 60 scorable questions across the four banks. Source PDFs and imported text are unchanged.

`lib/scoring.ts` defines the shared reference and pure calculation. `practiceSnapshot` derives the score server-side from persisted attempts, with no extra mutable score storage. Submission and retry responses supply their authoritative snapshot directly to the UI, so no extra request is required to update the score. Both practice and results views use `PracticeScore`. Navigation, reload, timer expiry, restart, and reset use the same persisted state. Restart resets only the chosen certification. Hidden-answer responses contain aggregates, never private answer keys or rationales.

Tests cover scale endpoints, the 720 boundary, invalid counts, all bank sizes, first-attempt persistence, all question formats, excluded questions, restart, and updates after correct and incorrect submissions. The existing full browser suite checks completion, refresh, mobile layout, and the practice flow.

## Verification completed

- 83 unit/API tests passed, including the importer’s repeated-seeding and source-integrity checks.
- All 24 Chromium integration tests passed. After adding the score beside the revealed answer, all six affected completion tests passed again across the four certifications.
- Production build, TypeScript, Prettier, and `git diff --check` passed. The project has no standalone linter.
- An isolated manual browser session submitted Professional single choice, multiple response, and scenario matching: the current estimate changed **1,000 → 550 → 700** after correct, incorrect, and correct submissions. Matching requires all five pairs; a partially correct multiple response earned no mark. The full-bank estimate changed **114 → 114 → 128**.
- Reload preserved 700 and the selected question. Restart returned to question one with no current estimate and a full-bank baseline of 100.
- Desktop and 390px mobile screenshots were inspected; the mobile document and viewport both measured 390px wide. Captures are local artifacts at `output/playwright/live-score-desktop.png` and `output/playwright/live-score-mobile.png`.
- The existing Developer source conflict remains flagged and excluded. Manual development-console output contained only the existing missing-favicon 404; no scoring errors occurred.
