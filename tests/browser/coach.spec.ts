import { test, expect } from "@playwright/test";

async function start(page: import("@playwright/test").Page, slug = "architect-professional") {
  await page.goto(`/exams/${slug}/practice`);
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chiikawa", exact: true })).toBeVisible();
}

test("draft persists, server submission stays frozen, hide and retry preserve progress", async ({
  page,
}) => {
  await start(page);
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeDisabled();
  await page.getByRole("radio").first().check();
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("radio").first()).toBeChecked();
  await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeDisabled();
  await expect(page.getByText("1 / 63", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide answer", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("radio").first()).not.toBeChecked();
  await expect(page.getByRole("radio").first()).toBeEnabled();
  await page.getByRole("radio").nth(1).check();
  await page.getByRole("button", { name: "Submit retry and reveal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toContainText(
    "review attempt",
  );
});

test("multiple response and matching require complete selections; navigation survives reload", async ({
  page,
}) => {
  await start(page);
  await page.locator("#question-nav").selectOption("professional-1.9");
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  await page.getByRole("checkbox").first().check();
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeDisabled();
  await page.getByRole("checkbox").nth(1).check();
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toBeVisible();
  await page.locator("#question-nav").selectOption("professional-1.11");
  await expect(page.locator(".match-select").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeDisabled();
  for (const select of await page.locator(".match-select").all()) await select.selectOption("A");
  await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("#question-nav")).toHaveValue("professional-1.11");
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toHaveCount(0);
});

test("provider failure leaves practice usable; progress reset deletes saved attempts", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Get a hint", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "setup is incomplete" })).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset learning progress", exact: true }).click();
  await page.getByRole("button", { name: "Delete my progress", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeVisible();
  await expect(page.getByText("0 / 63", { exact: true })).toBeVisible();
});

test("timer survives refresh, mobile layout fits, source conflict is flagged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/exams/architect-professional/practice");
  await page.getByRole("radio", { name: /Timed practice/ }).check();
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.getByRole("timer")).toBeVisible();
  const before = await page.request.get("/api/practice?certification=architect-professional");
  const deadline = (await before.json()).settings.deadline;
  await page.reload();
  await expect(page.getByRole("timer")).toBeVisible();
  const after = await page.request.get("/api/practice?certification=architect-professional");
  expect((await after.json()).settings.deadline).toBe(deadline);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "output/playwright/mobile-coach.png", fullPage: true });
  await page.goto("/exams/developer-foundations/practice?question=developer-5.9");
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(
    page.getByText("Source review required — excluded from scoring and coaching", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a hint", exact: true })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Chiikawa", exact: true })).toContainText(
    "Chiikawa is unavailable while this question is flagged for source review.",
  );
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reveal without answering", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toContainText(
    "Disputed source answer",
  );
});

test("landing lists all four certifications and invalid IDs fail safely", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cert-card")).toHaveCount(4);
  await page.goto("/exams/does-not-exist/practice");
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  expect((await page.request.get("/api/practice?certification=missing")).status()).toBe(404);
  expect((await page.request.post("/api/questions/999999999/answer")).status()).toBe(404);
});

test("keyboard controls work and hiding discards a late tutor response", async ({ page }) => {
  await start(page);
  expect(await page.content()).not.toContain('"correctKeys"');
  const radio = page.getByRole("radio").first();
  await radio.focus();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  await expect(page.getByRole("button", { name: "Submit and reveal", exact: true })).toBeEnabled();
  const reveal = page.getByRole("button", { name: "Reveal without answering", exact: true });
  await reveal.focus();
  expect(await reveal.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    "none",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toBeVisible();
  let release!: () => void;
  let received!: () => void;
  let completed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route("**/api/tutor", async (route) => {
    received();
    await gate;
    try {
      await route.fulfill({
        contentType: "text/event-stream",
        body: [
          { type: "start", runId: "mock-run", answerRevealed: true },
          { type: "delta", field: "message", text: "STALE ANSWER SHOULD NOT APPEAR" },
          { type: "error", error: "Stale request", code: "stale" },
        ]
          .map((event) => "data: " + JSON.stringify(event) + "\n\n")
          .join(""),
      });
    } finally {
      completed();
    }
  });
  await page.getByRole("button", { name: "Review my answer", exact: true }).click();
  await started;
  await page.getByRole("button", { name: "Hide answer", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toHaveCount(0);
  release();
  await finished;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByText("STALE ANSWER SHOULD NOT APPEAR", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "output/playwright/desktop-coach.png", fullPage: true });
});
