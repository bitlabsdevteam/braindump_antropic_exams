import type { PracticeResult } from "../lib/practice-types";
import { SCORING_REFERENCE } from "../lib/scoring";

export default function PracticeScore({ result }: { result: PracticeResult }) {
  const { score } = result;
  const complete = result.total > 0 && result.unanswered === 0;
  return (
    <section className="practice-score" aria-label="Practice score">
      <div className="practice-score-values" role="status" aria-live="polite" aria-atomic="true">
        <div>
          <span className="score-label">
            {complete ? "Completed practice score estimate" : "Current practice score estimate"}
          </span>
          <strong className="practice-score-number" data-testid="current-score">
            {score.current === null ? "—" : score.current} <small>/ 1,000</small>
          </strong>
          <p className="practice-score-caption">
            {score.current === null
              ? "Submit your first answer to see your score."
              : `${result.correct} correct of ${result.attempted} submitted · ${score.accuracy}% accuracy`}
          </p>
        </div>
        <div>
          <span className="score-label">Official passing reference</span>
          <strong className="practice-score-number">
            720 <small>/ 1,000</small>
          </strong>
          <p className="practice-score-caption" data-testid="score-reference-status">
            {score.referenceReached === null
              ? "No scored answers yet"
              : `${score.referenceReached ? "At or above" : "Below"} the reference${complete ? "" : " · provisional"}`}
          </p>
        </div>
        <p className="practice-score-coverage">
          {result.attempted} of {result.total} scorable questions submitted · {result.unanswered}{" "}
          unanswered. Full-bank estimate:{" "}
          <strong data-testid="full-bank-score">{score.fullBank ?? "—"} / 1,000</strong> (unanswered
          questions earn no marks).
        </p>
      </div>
      <details className="practice-score-method">
        <summary>How this practice estimate works</summary>
        <p>
          The current estimate is 100 + 900 × (correct ÷ submitted), rounded down. The full-bank
          estimate uses all scorable questions instead of submitted questions. Both estimates match
          when practice is complete. Each question earns one mark only when every required answer or
          match is correct. First submissions count; retries do not change the score. Revealing
          without submitting earns no mark. Source-review questions are excluded.
        </p>
        <p>
          Included first attempts: {result.independent} independent, {result.assisted} assisted, and{" "}
          {result.review} after seeing the answer.
        </p>
        <p>
          <a href={SCORING_REFERENCE.sourceUrl}>Anthropic’s scoring FAQ</a> confirms a 100–1,000
          scale and a 720 passing score for all four certifications. Official scores adjust for exam
          difficulty; the published guides do not supply the conversion formula. This linear
          practice estimate cannot predict an official score or pass. 720 is not an official 72%
          accuracy requirement.
        </p>
      </details>
      <p className="practice-score-disclaimer">
        Practice estimate only · not an official exam score or pass prediction.
      </p>
    </section>
  );
}
