import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Populate isolated browser-test SQLite, not the user's database or a mocked API.
async function seedMemory(page: import("@playwright/test").Page) {
  await page.goto("/exams/architect-professional/practice");
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.locator("#active-question")).toBeVisible();
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === "ai_tutor_session",
  )!.value;
  const db = new Database(path.resolve("output/playwright/learning.db"));
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO tutor_turns(session_id,source_key,request_id,answer_revealed,user_text,assistant_json,tools_json,prompt_hash,created_at)
    VALUES (?, 'professional-1.1', 'browser-hidden-memory', 0, 'I prefer brief examples.', ?, '[]', 'browser-fixture', ?)`,
  ).run(
    session,
    JSON.stringify({
      message: "HIDDEN_PHASE_EXPLANATION",
      concept: "A conceptual distinction.",
      nextStep: "Try a neutral example.",
    }),
    Date.now(),
  );
  const turn = db
    .prepare(
      "SELECT id FROM tutor_turns WHERE session_id = ? AND request_id = 'browser-hidden-memory'",
    )
    .get(session) as { id: number };
  db.prepare(
    "INSERT INTO tutor_preferences VALUES (?, 'depth', 'brief', ?, 'I prefer brief examples.', ?)",
  ).run(session, turn.id, Date.now());
  db.prepare(
    `INSERT INTO tutor_turns(session_id,source_key,request_id,answer_revealed,user_text,assistant_json,tools_json,prompt_hash,created_at)
    VALUES (?, 'professional-1.1', 'browser-revealed-memory', 1, 'Explain the revealed answer.', ?, '[]', 'browser-fixture', ?)`,
  ).run(
    session,
    JSON.stringify({
      message: "REVEALED_PHASE_EXPLANATION",
      concept: "Source explanation.",
      nextStep: "Review the source.",
    }),
    Date.now(),
  );
  db.close();
}

test("memory inspector survives refresh, scopes history to reveal permission, and forgets without resetting grades", async ({
  page,
}) => {
  await seedMemory(page);
  await page.getByRole("button", { name: "Memory & conversation history" }).click();
  await expect(page.getByText("depth: brief", { exact: true })).toBeVisible();
  await expect(page.getByText("HIDDEN_PHASE_EXPLANATION", { exact: false })).toBeVisible();
  await expect(page.getByText("REVEALED_PHASE_EXPLANATION", { exact: false })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Memory & conversation history" }).click();
  await expect(page.getByText("depth: brief", { exact: true })).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
  await page.getByRole("button", { name: "Memory & conversation history" }).click();
  await expect(page.getByText("REVEALED_PHASE_EXPLANATION", { exact: false })).toBeVisible();
  await expect(page.getByText("HIDDEN_PHASE_EXPLANATION", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Hide answer", exact: true }).click();
  await expect(page.getByText("REVEALED_PHASE_EXPLANATION", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Memory & conversation history" }).click();
  await page.getByRole("button", { name: "Forget depth preference" }).click();
  await expect(page.getByText("No preferences saved yet.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Forget all study memory", exact: true }).click();
  await page.getByRole("button", { name: "Forget memory", exact: true }).click();
  await expect(
    page.getByText("No completed conversations in this phase yet.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1 / 63", { exact: true })).toBeVisible();
});

test("memory history fits mobile and a late revealed-history fetch is discarded after hiding", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMemory(page);
  await page.getByRole("button", { name: "Reveal without answering", exact: true }).click();
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/api/tutor/memory?**", async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Memory & conversation history" }).click();
  await started;
  await page.getByRole("button", { name: "Hide answer", exact: true }).click();
  release();
  await expect(page.getByText("REVEALED_PHASE_EXPLANATION", { exact: false })).toHaveCount(0);
  await page.unroute("**/api/tutor/memory?**");
  await page.getByRole("button", { name: "Memory & conversation history" }).click();
  await expect(page.getByText("HIDDEN_PHASE_EXPLANATION", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "output/playwright/chiikawa-memory-mobile.png", fullPage: true });
});
