import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePracticeScore } from "../lib/scoring";

test("practice estimates distinguish no attempts, wrong answers, accuracy, and bank coverage", () => {
  assert.deepEqual(calculatePracticeScore(0, 0, 63), {
    current: null,
    fullBank: 100,
    accuracy: null,
    referenceReached: null,
  });
  assert.deepEqual(calculatePracticeScore(0, 1, 63), {
    current: 100,
    fullBank: 100,
    accuracy: 0,
    referenceReached: false,
  });
  assert.deepEqual(calculatePracticeScore(1, 1, 63), {
    current: 1000,
    fullBank: 114,
    accuracy: 100,
    referenceReached: true,
  });
  assert.deepEqual(calculatePracticeScore(1, 2, 63), {
    current: 550,
    fullBank: 114,
    accuracy: 50,
    referenceReached: false,
  });
  assert.deepEqual(calculatePracticeScore(0, 0, 0), {
    current: null,
    fullBank: null,
    accuracy: null,
    referenceReached: null,
  });
});

test("720 reference uses the linear estimate, not a supposed official 72% raw cutoff", () => {
  assert.equal(calculatePracticeScore(31, 45, 63).current, 720);
  assert.equal(calculatePracticeScore(31, 45, 63).referenceReached, true);
  assert.equal(calculatePracticeScore(6888, 10000, 10000).current, 719);
  assert.equal(calculatePracticeScore(6888, 10000, 10000).referenceReached, false);
  assert.equal(calculatePracticeScore(72, 100, 100).current, 748);
});

test("completed estimates agree, remain bounded, and increase with correct answers for every bank", () => {
  for (const total of [63, 60, 52]) {
    let previous = 99;
    for (let correct = 0; correct <= total; correct++) {
      const score = calculatePracticeScore(correct, total, total);
      assert.equal(score.current, score.fullBank);
      assert.ok(score.current! >= 100 && score.current! <= 1000);
      assert.ok(score.current! > previous);
      previous = score.current!;
    }
    assert.equal(previous, 1000);
  }
});

test("invalid score counts fail rather than producing misleading scores", () => {
  for (const counts of [
    [-1, 0, 63],
    [2, 1, 63],
    [1, 64, 63],
    [0, 0, -1],
    [0.5, 1, 63],
    [NaN, 1, 63],
    [0, Infinity, 63],
  ])
    assert.throws(
      () => calculatePracticeScore(...(counts as [number, number, number])),
      RangeError,
    );
});
