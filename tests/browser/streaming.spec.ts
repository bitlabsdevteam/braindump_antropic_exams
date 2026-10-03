import { test, expect, type Page } from "@playwright/test";

type MockStream = {
  emit: (event: unknown) => void;
  finish: () => void;
  state: Record<string, unknown>;
  requests: number;
  cancelled: number;
};
async function setup(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let source: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fixture: MockStream = {
      emit(event) {
        try {
          source?.enqueue(new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"));
        } catch {
          /* The client has cancelled this stream. */
        }
      },
      finish() {
        fixture.emit({
          type: "complete",
          reply: {
            runId: "browser-run",
            approach: "We will compare responsibilities.",
            message: "Consider the responsibility of each component.",
            concept: "Separate responsibilities.",
            nextStep: "Identify the boundary.",
            relatedQuestions: [],
            state: { ...fixture.state, hintCount: 1 },
          },
        });
      },
      state: {},
      requests: 0,
      cancelled: 0,
    };
    (window as unknown as { tutorStream: MockStream }).tutorStream = fixture;
    window.fetch = async (input, init) => {
      if (input === "/api/tutor" && init?.method === "POST") {
        if (new Headers(init.headers).get("Accept") !== "text/event-stream")
          throw new Error("Expected streaming request");
        fixture.requests += 1;
        const { questionId } = JSON.parse(String(init.body));
        fixture.state = (
          await (
            await original(
              "/api/practice?certification=architect-professional&questionId=" + questionId,
            )
          ).json()
        ).state;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
          cancel() {
            fixture.cancelled += 1;
          },
        });
        fixture.emit({
          type: "start",
          runId: "browser-run",
          answerRevealed: fixture.state.visible,
        });
        fixture.emit({ type: "activity", id: "model-1", stage: "model", state: "active" });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return original(input, init);
    };
  });
  await page.goto("/exams/architect-professional/practice");
  await expect(page.getByRole("complementary", { name: "Chiikawa", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chiikawa", exact: true })).toBeVisible();
}
async function emit(page: Page, event: unknown) {
  await page.evaluate(
    (value) => (window as unknown as { tutorStream: MockStream }).tutorStream.emit(value),
    event,
  );
}
async function begin(page: Page, name = "Get a hint") {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByText("Waiting for Chiikawa’s response", { exact: true }).first(),
  ).toBeVisible();
}

test("actual stream chunks appear before completion without changing focus or committing hint state", async ({
  page,
}) => {
  await setup(page);
  await begin(page);
  await page.getByLabel("Ask Chiikawa a follow-up").focus();
  await emit(page, { type: "delta", field: "approach", text: "We will compare responsibilities." });
  await emit(page, { type: "delta", field: "message", text: "Consider the responsibility" });
  await expect(page.getByText("Consider the responsibility", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Teaching approach" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a hint", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Ask Chiikawa a follow-up")).toBeFocused();
  await emit(page, { type: "delta", field: "message", text: " of each component." });
  await expect(
    page.getByText("Consider the responsibility of each component.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { tutorStream: MockStream }).tutorStream.finish(),
  );
  await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next hint · stage 2/3" })).toBeEnabled();
  await expect(page.getByText("Identify the boundary.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Ask Chiikawa a follow-up")).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as { tutorStream: MockStream }).tutorStream.cancelled,
    ),
  ).toBe(1);
});

test("Stop clears partial output, rejects late chunks, and allows a new request", async ({
  page,
}) => {
  await setup(page);
  await begin(page);
  await emit(page, { type: "delta", field: "message", text: "Partial teaching text" });
  await expect(page.getByText("Partial teaching text", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(
    page.getByText("Chiikawa’s response stopped. You can ask again.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Partial teaching text", { exact: true })).toHaveCount(0);
  await emit(page, { type: "delta", field: "message", text: "LATE CANCELLED TEXT" });
  await expect(page.getByText("LATE CANCELLED TEXT")).toHaveCount(0);
  await begin(page);
  await page.evaluate(() =>
    (window as unknown as { tutorStream: MockStream }).tutorStream.finish(),
  );
  await expect(page.getByText("Identify the boundary.", { exact: true })).toBeVisible();
});

test("hiding an answer discards streamed review text and ignores late completion", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Reveal without answering", exact: true }).click();
  await begin(page, "Review my answer");
  await emit(page, { type: "delta", field: "message", text: "Revealed answer review" });
  await expect(page.getByText("Revealed answer review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide answer", exact: true }).click();
  await expect(page.getByRole("region", { name: "Source answer", exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { tutorStream: MockStream }).tutorStream.finish(),
  );
  await expect(page.getByText("Revealed answer review", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Identify the boundary.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get a hint", exact: true })).toBeEnabled();
});

test("retry reset and stream errors roll back partial content and remain usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await begin(page);
  await emit(page, { type: "delta", field: "message", text: "Discard the first partial" });
  await expect(page.getByText("Discard the first partial")).toBeVisible();
  await emit(page, { type: "reset", reason: "retry" });
  await expect(page.getByText("Discard the first partial")).toHaveCount(0);
  await emit(page, { type: "delta", field: "message", text: "Discard the retry partial" });
  await expect(page.getByText("Discard the retry partial")).toBeVisible();
  await emit(page, {
    type: "error",
    error: "The connection was interrupted. Try again.",
    code: "provider_unavailable",
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "connection was interrupted" }),
  ).toBeVisible();
  await expect(page.getByText("Discard the retry partial")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Get a hint", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

for (const width of [390, 768, 1024, 1440]) {
  test(`Chiikawa workspace fits at ${width}px and preserves one stream across resizing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    const panel = page.getByRole("complementary", { name: "Chiikawa", exact: true });
    const card = page.locator(".question-card");
    await expect(panel).toHaveCount(1);
    const panelBox = (await panel.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    if (width >= 1024) {
      expect(Math.abs(panelBox.y - cardBox.y)).toBeLessThan(2);
      expect(panelBox.width).toBe(340);
      expect(panelBox.x + panelBox.width).toBeLessThan(cardBox.x);
      expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
    } else {
      expect(panelBox.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
      await page.getByRole("button", { name: "Ask Chiikawa", exact: true }).click();
      await expect(page.locator("#chiikawa-heading")).toBeFocused();
      await page.getByRole("button", { name: "Back to question" }).click();
      await expect(page.locator("#active-question")).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await begin(page);
    await page.getByLabel("Ask Chiikawa a follow-up").fill("Keep my draft while resizing");
    await emit(page, { type: "delta", field: "message", text: "A small conceptual step." });
    await expect(panel).toContainText("A small conceptual step.");
    await page.screenshot({ path: `output/playwright/chiikawa-${width}.png`, fullPage: true });
    await page.setViewportSize({ width: width >= 1024 ? 390 : 1440, height: 900 });
    await expect(panel).toHaveCount(1);
    await expect(panel).toContainText("A small conceptual step.");
    await expect(page.getByLabel("Ask Chiikawa a follow-up")).toHaveValue(
      "Keep my draft while resizing",
    );
    await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(1);
    expect(
      await page.evaluate(
        () => (window as unknown as { tutorStream: MockStream }).tutorStream.requests,
      ),
    ).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Stop response" }).click();
  });
}

test("long responses scroll independently without moving the learner to new text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await begin(page);
  const content = page.getByRole("region", { name: "Chiikawa conversation" });
  await emit(page, {
    type: "delta",
    field: "message",
    text: "Consider this neutral example.\n".repeat(100),
  });
  await expect(content).toContainText("Consider this neutral example.");
  const dimensions = await content.evaluate((el) => ({
    height: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(dimensions.height).toBeGreaterThan(40);
  expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
  await content.focus();
  await Promise.all([
    content.evaluate(
      (el) =>
        new Promise<void>((resolve) =>
          el.addEventListener("scrollend", () => resolve(), { once: true }),
        ),
    ),
    page.keyboard.press("PageDown"),
  ]);
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await content.evaluate((el) => {
    el.scrollTop = 60;
  });
  const before = await content.evaluate((el) => el.scrollTop);
  await emit(page, {
    type: "delta",
    field: "message",
    text: "New text should not force a scroll.",
  });
  await expect(content).toContainText("New text should not force a scroll.");
  expect(await content.evaluate((el) => el.scrollTop)).toBe(before);
  await expect(content).toBeFocused();
  await expect(page.getByRole("button", { name: "Stop response" })).toBeInViewport();
  await page.getByRole("button", { name: "Stop response" }).click();
});

test("domain navigation and progress reset cancel an in-flight response", async ({ page }) => {
  await setup(page);
  await begin(page);
  await emit(page, { type: "delta", field: "message", text: "Old domain coaching" });
  await page.getByLabel("Domain", { exact: true }).selectOption("2");
  await expect(page.locator("#question-nav")).toHaveValue("professional-2.1");
  await expect(page.getByText("Old domain coaching", { exact: true })).toHaveCount(0);
  await expect(page.locator("#active-question")).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as { tutorStream: MockStream }).tutorStream.cancelled,
    ),
  ).toBe(1);
  await page.reload();
  await expect(page.getByLabel("Domain", { exact: true })).toHaveValue("2");
  await expect(page.locator("#question-nav")).toHaveValue("professional-2.1");
  await begin(page);
  await page.getByRole("button", { name: "Reset learning progress", exact: true }).click();
  await page.getByRole("button", { name: "Delete my progress", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start practice", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Chiikawa", exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { tutorStream: MockStream }).tutorStream.cancelled,
    ),
  ).toBe(1);
});
