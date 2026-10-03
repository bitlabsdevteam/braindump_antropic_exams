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
  await page.getByRole("button", { name: "Start practice", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your question coach", exact: true }),
  ).toBeVisible();
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
    page.getByText("Waiting for the tutor’s response", { exact: true }).first(),
  ).toBeVisible();
}

test("actual stream chunks appear before completion without changing focus or committing hint state", async ({
  page,
}) => {
  await setup(page);
  await begin(page);
  await page.getByLabel("Ask a follow-up").focus();
  await emit(page, { type: "delta", field: "approach", text: "We will compare responsibilities." });
  await emit(page, { type: "delta", field: "message", text: "Consider the responsibility" });
  await expect(page.getByText("Consider the responsibility", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tutor approach" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get a hint", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Ask a follow-up")).toBeFocused();
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
  await expect(page.getByLabel("Ask a follow-up")).toBeFocused();
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
    page.getByText("Response stopped. You can ask again.", { exact: true }),
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
