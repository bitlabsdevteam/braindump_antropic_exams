import { test, expect } from "@playwright/test";

test("the last question offers completion instead of a disabled Next button", async ({ page }) => {
  await page.goto("/exams/architect-professional/practice?question=professional-7.4");
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.locator("#question-nav")).toHaveValue("professional-7.4");
  await expect(page.getByTestId("current-score")).toHaveText("— / 1,000");
  await expect(
    page.getByRole("button", { name: "Finish and view results", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Finish and view results", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Chiikawa", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your practice result", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("final-mark")).toHaveText("0 / 63");
  await expect(page.getByTestId("final-percentage")).toHaveText("0%");
  await expect(page.getByText("63 unanswered", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your practice result", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review questions", exact: true }).click();
  await expect(page.locator("#question-nav")).toHaveValue("professional-7.4");
});

// Authoritative fixtures are read only by the test process, never exposed by the app.
import Database from "better-sqlite3";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
type Fixture = {
  id: number;
  sourceKey: string;
  type: string;
  correctKeys: string[];
  options: string[];
};
function fixtures(slug: string): Fixture[] {
  const db = new Database(path.resolve("output/playwright/exams.db"), { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT q.id, q.source_key as sourceKey, q.type, a.correct_keys as answer FROM questions q JOIN certifications c ON c.id = q.certification_id JOIN answers a ON a.question_id = q.id WHERE c.slug = ? AND q.review_required = 0 ORDER BY q.ordinal`,
      )
      .all(slug) as { id: number; sourceKey: string; type: string; answer: string }[];
    return rows.map((row) => ({
      ...row,
      correctKeys: JSON.parse(row.answer),
      options: (
        db
          .prepare("SELECT option_key as key FROM options WHERE question_id = ? ORDER BY ordinal")
          .all(row.id) as { key: string }[]
      ).map((option) => option.key),
    }));
  } finally {
    db.close();
  }
}
async function submitFixture(
  request: APIRequestContext,
  certification: string,
  question: Fixture,
  selectedKeys: string[],
) {
  const draft = await request.post("/api/practice", {
    data: {
      action: "draft",
      certification,
      questionId: question.id,
      selectedKeys,
      reasoning: "",
      revision: 0,
    },
  });
  expect(draft.ok(), await draft.text()).toBe(true);
  const { state } = await draft.json();
  const submit = await request.post("/api/practice", {
    data: {
      action: "submit",
      certification,
      questionId: question.id,
      revision: state.revision,
      requestId: `completion-${question.id}`,
    },
  });
  expect(submit.ok(), await submit.text()).toBe(true);
}
async function selectCorrect(page: Page, question: Fixture) {
  if (question.type === "scenario_matching") {
    for (const pairing of question.correctKeys) {
      const [item, option] = pairing.split(":");
      await page.locator(`#match-${item}`).selectOption(option);
    }
  } else {
    for (const key of question.correctKeys)
      await page
        .getByRole(question.type === "single_choice" ? "radio" : "checkbox")
        .nth(question.options.indexOf(key))
        .check();
  }
}
for (const [slug, total] of [
  ["architect-professional", 63],
  ["architect-foundations", 60],
  ["developer-foundations", 52],
  ["associate-foundations", 60],
] as const) {
  test(`${slug}: complete exam includes last answer, shows exact final mark, and survives refresh`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const questions = fixtures(slug);
    const last = questions.at(-1)!;
    await page.goto(`/exams/${slug}/practice?question=${last.sourceKey}`);
    await page.getByRole("button", { name: "Start practice", exact: true }).click();
    await expect(page.locator("#question-nav")).toHaveValue(last.sourceKey);
    for (const [index, question] of questions.slice(0, -1).entries()) {
      // One wrong first attempt proves the result is calculated, not just a completed count.
      const selections =
        index === 0
          ? [
              question.options.find((key) => !question.correctKeys.includes(key))!,
              ...question.correctKeys.slice(1),
            ]
          : question.correctKeys;
      await submitFixture(page.request, slug, question, selections);
    }
    await selectCorrect(page, last);
    await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
    await expect(page.getByRole("region", { name: "Source answer", exact: true })).toBeVisible();
    const expectedScore = Math.floor((100 * total + 900 * (total - 1)) / total);
    await expect(page.getByTestId("current-score")).toHaveText(`${expectedScore} / 1,000`);
    await expect(page.getByTestId("question-score")).toContainText(`${expectedScore} / 1,000`);
    await page.getByRole("button", { name: "Finish and view results", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Chiikawa", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Your practice result", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("final-mark")).toHaveText(`${total - 1} / ${total}`);
    await expect(page.getByTestId("final-percentage")).toHaveText(
      `${Math.round(((total - 1) / total) * 100)}%`,
    );
    await expect(page.getByText("0 unanswered", { exact: true })).toBeVisible();
    if (slug === "developer-foundations")
      await expect(
        page.getByText("1 source-review question is excluded from the score and total.", {
          exact: true,
        }),
      ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("final-mark")).toHaveText(`${total - 1} / ${total}`);
    await expect(page.getByTestId("current-score")).toHaveText(`${expectedScore} / 1,000`);
    await expect(page.getByTestId("full-bank-score")).toHaveText(`${expectedScore} / 1,000`);
    await page.getByRole("button", { name: "Review questions", exact: true }).click();
    await expect(page.locator("#question-nav")).toHaveValue(last.sourceKey);
    await page.getByRole("button", { name: "View results", exact: true }).click();
    await expect(page.getByTestId("final-mark")).toHaveText(`${total - 1} / ${total}`);
    if (slug === "architect-professional") {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: "output/playwright/exam-results-mobile.png", fullPage: true });
    }
  });
}

test("expired timer exposes results without requiring navigation to the last question", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/exams/architect-professional/practice");
  await page.getByRole("radio", { name: /Timed practice/ }).check();
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.getByRole("timer")).toBeVisible();
  await page.clock.fastForward(121 * 60 * 1000);
  await page.getByRole("button", { name: "View results", exact: true }).click();
  await expect(page.getByTestId("final-mark")).toHaveText("0 / 63");
  await page.getByRole("button", { name: "Continue unanswered questions", exact: true }).click();
  await expect(page.locator("#question-nav")).toHaveValue("professional-1.1");
});
