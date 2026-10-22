import type { AttemptKind, Confidence } from "./practice-types";

// Leitner intervals in days for boxes 1..4. Derived from attempt history on demand, so
// restarting an exam or resetting a session cannot leave a stale schedule behind.
export const reviewIntervalDays = [1, 2, 4, 7] as const;
const dayMs = 24 * 60 * 60 * 1000;

export type ScheduleAttempt = {
  correct: boolean;
  confidence?: Confidence | null;
  kind?: AttemptKind;
  at: number;
};
export type ReviewSlot = { box: number; dueAt: number };

/**
 * Box 1 after a miss. A correct answer promotes one box only once the current interval
 * has elapsed, so same-day retries after a reveal never inflate the schedule. A correct
 * guess is not evidence of knowledge and keeps the box, and neither is a first attempt made
 * after seeing the source answer (kind "review"); later retries still promote normally.
 * `attempts` must be oldest first.
 */
export function reviewSlot(attempts: ScheduleAttempt[]): ReviewSlot | null {
  if (!attempts.length) return null;
  let box = 0;
  let dueAt = 0;
  for (const attempt of attempts) {
    if (!attempt.correct) {
      box = 1;
      dueAt = attempt.at + reviewIntervalDays[0] * dayMs;
    } else if (box === 0) {
      box = attempt.confidence === "guess" || attempt.kind === "review" ? 1 : 2;
      dueAt = attempt.at + reviewIntervalDays[box - 1] * dayMs;
    } else if (attempt.at >= dueAt && attempt.confidence !== "guess") {
      box = Math.min(box + 1, reviewIntervalDays.length);
      dueAt = attempt.at + reviewIntervalDays[box - 1] * dayMs;
    } else if (attempt.at >= dueAt) {
      dueAt = attempt.at + reviewIntervalDays[box - 1] * dayMs;
    }
  }
  return { box, dueAt };
}

export function dueSourceKeys(
  history: Map<string, ScheduleAttempt[]>,
  now: number,
  eligible: (key: string) => boolean = () => true,
) {
  const due: { key: string; dueAt: number }[] = [];
  for (const [key, attempts] of history) {
    const slot = eligible(key) ? reviewSlot(attempts) : null;
    if (slot && slot.dueAt <= now) due.push({ key, dueAt: slot.dueAt });
  }
  return due.sort((a, b) => a.dueAt - b.dueAt).map((item) => item.key);
}
