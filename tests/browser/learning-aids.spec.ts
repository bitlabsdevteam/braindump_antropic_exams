import { test, expect } from "@playwright/test";

test("hints, confidence, and study notes support a question without leaking the answer", async ({
  page,
}) => {
  await page.goto("/exams/associate-foundations/practice?question=associate-1.1");
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.locator("#question-nav")).toHaveValue("associate-1.1");

  // Hints and study notes are fetched on demand, never present in the initial page source.
  const source = await (await page.request.get(page.url())).text();
  expect(source).not.toContain("what the model would still have to guess");
  expect(source).not.toContain("Five ingredients");
  await expect(page.getByTestId("study-notes")).toHaveCount(0);

  await page.getByRole("button", { name: "Show hint 1 of 3", exact: true }).click();
  await expect(page.getByText("would still have to guess")).toBeVisible();
  await page.reload();
  await expect(page.getByText("would still have to guess")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show hint 2 of 3", exact: true })).toBeVisible();

  await page.getByRole("radio", { name: /LinkedIn post/ }).check();
  await page.getByRole("radio", { name: "Sure", exact: true }).check();
  await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();

  await expect(page.getByTestId("calibration")).toContainText("sure and correct");
  await expect(page.getByText("assisted attempt")).toBeVisible();
  const notes = page.getByTestId("study-notes");
  await expect(notes).toContainText("draft, not yet reviewed");
  await expect(notes).toContainText("Five ingredients");
  await expect(notes).toContainText("(in the source answer)");

  // The first review interval is one day, so nothing is due straight after an attempt.
  await expect(page.getByRole("button", { name: /^Due today \(0\)$/ })).toBeDisabled();

  // Hints are no longer offered once the answer has been shown.
  await expect(page.getByRole("button", { name: /Show hint/ })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const overflows = (page: import("@playwright/test").Page) =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  test("multiple response keeps hints and study notes inside the viewport", async ({ page }) => {
    await page.goto("/exams/associate-foundations/practice?question=associate-1.7");
    await page.getByRole("button", { name: "Start practice", exact: true }).click();
    for (const stage of [1, 2, 3])
      await page.getByRole("button", { name: `Show hint ${stage} of 3`, exact: true }).click();
    await expect(page.getByText("All hints shown.")).toBeVisible();
    await page.getByRole("checkbox", { name: /Naming the audience/ }).check();
    await page.getByRole("checkbox", { name: /Specifying format/ }).check();
    await page.getByRole("radio", { name: "Unsure", exact: true }).check();
    await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
    await expect(page.getByTestId("study-notes")).toContainText("Aim (who and why)");
    await expect(page.getByTestId("study-notes")).toContainText("(in the source answer)");
    expect(await overflows(page)).toBe(false);
  });

  test("matching shows per-option notes without a misleading source-answer tag", async ({
    page,
  }) => {
    await page.goto("/exams/architect-professional/practice?question=professional-1.11");
    await page.getByRole("button", { name: "Start practice", exact: true }).click();
    await page.getByRole("button", { name: "Show hint 1 of 3", exact: true }).click();
    for (const item of [1, 2, 3, 4, 5])
      await page.locator(`#match-${item}`).selectOption({ index: 1 });
    await page.getByRole("button", { name: "Submit and reveal", exact: true }).click();
    const notes = page.getByTestId("study-notes");
    await expect(notes).toContainText("multi-agent system suits distinct specialists");
    await expect(notes).not.toContainText("(in the source answer)");
    expect(await overflows(page)).toBe(false);
  });
});
