// Sources and the limits of this practice approximation: docs/scoring.md.
export const SCORING_REFERENCE = {
  minimum: 100,
  maximum: 1000,
  passing: 720,
  sourceUrl: "https://anthropic-partners.skilljar.com/page/faq-certifications",
} as const;

export type PracticeScore = {
  current: number | null;
  fullBank: number | null;
  accuracy: number | null;
  referenceReached: boolean | null;
};

export function calculatePracticeScore(
  correct: number,
  attempted: number,
  total: number,
): PracticeScore {
  if (
    ![correct, attempted, total].every(Number.isSafeInteger) ||
    correct < 0 ||
    attempted < correct ||
    total < attempted
  )
    throw new RangeError("Invalid practice score counts");
  const { minimum, maximum, passing } = SCORING_REFERENCE;
  // Round down so display rounding cannot promote a score below the reference.
  const estimate = (denominator: number) =>
    Math.floor((minimum * denominator + (maximum - minimum) * correct) / denominator);
  const current = attempted ? estimate(attempted) : null;
  return {
    current,
    fullBank: total ? estimate(total) : null,
    accuracy: attempted ? Math.round((correct / attempted) * 100) : null,
    referenceReached: current === null ? null : current >= passing,
  };
}
