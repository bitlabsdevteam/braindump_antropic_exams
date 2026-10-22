import assert from "node:assert/strict";
import { test } from "node:test";
import { dueSourceKeys, reviewSlot, type ScheduleAttempt } from "../lib/review-schedule";

const day = 24 * 60 * 60 * 1000;
const at = (days: number) => days * day;
const attempt = (
  days: number,
  correct: boolean,
  confidence?: ScheduleAttempt["confidence"],
): ScheduleAttempt => ({ correct, confidence, at: at(days) });

test("a miss goes to box 1 and is due the next day", () => {
  assert.deepEqual(reviewSlot([attempt(0, false)]), { box: 1, dueAt: at(1) });
  assert.equal(reviewSlot([]), null);
});

test("correct answers promote only after the interval has elapsed", () => {
  assert.deepEqual(reviewSlot([attempt(0, true, "sure")]), { box: 2, dueAt: at(2) });
  // A same-day retry after the reveal must not inflate the box.
  assert.deepEqual(reviewSlot([attempt(0, false), attempt(0.01, true)]), {
    box: 1,
    dueAt: at(1),
  });
  assert.deepEqual(reviewSlot([attempt(0, false), attempt(1, true)]), { box: 2, dueAt: at(3) });
  assert.deepEqual(reviewSlot([attempt(0, true), attempt(2, true), attempt(6, true)]), {
    box: 4,
    dueAt: at(13),
  });
});

test("a miss demotes to box 1 and a correct guess never promotes", () => {
  assert.deepEqual(reviewSlot([attempt(0, true), attempt(2, true), attempt(6, false)]), {
    box: 1,
    dueAt: at(7),
  });
  assert.deepEqual(reviewSlot([attempt(0, true, "guess")]), { box: 1, dueAt: at(1) });
  assert.deepEqual(reviewSlot([attempt(0, false), attempt(1, true, "guess")]), {
    box: 1,
    dueAt: at(2),
  });
});

test("due keys are overdue-first and respect eligibility", () => {
  const history = new Map<string, ScheduleAttempt[]>([
    ["a", [attempt(0, false)]],
    ["b", [attempt(-3, false)]],
    ["c", [attempt(0.5, false)]],
    ["skipped", [attempt(-5, false)]],
  ]);
  assert.deepEqual(
    dueSourceKeys(history, at(1.2), (key) => key !== "skipped"),
    ["b", "a"],
  );
});

test("seeing the answer first earns no promotion, but later retries still do", () => {
  const seen = (days: number, correct: boolean): ScheduleAttempt => ({
    correct,
    kind: "review",
    at: at(days),
  });
  assert.deepEqual(reviewSlot([seen(0, true)]), { box: 1, dueAt: at(1) });
  assert.deepEqual(reviewSlot([seen(0, true), seen(1, true)]), { box: 2, dueAt: at(3) });
  // Every retry after a miss is "review" too; it must still promote after the interval.
  assert.deepEqual(reviewSlot([attempt(0, false), seen(1, true), seen(3, true)]), {
    box: 3,
    dueAt: at(7),
  });
});
