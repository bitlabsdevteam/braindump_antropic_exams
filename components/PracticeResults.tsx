"use client";

import { useEffect, useRef } from "react";
import type { PracticeResult } from "../lib/practice-types";

export default function PracticeResults({
  result,
  onReview,
  onUnanswered,
  disabled,
}: {
  result: PracticeResult;
  onReview: () => void;
  onUnanswered: () => void;
  disabled: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="results-view" aria-labelledby="practice-result-title">
      <div className="results-header">
        <div>
          <p className="eyebrow">Practice results</p>
          <h2 id="practice-result-title" tabIndex={-1} ref={heading}>
            Your practice result
          </h2>
          <p>
            One mark per scorable question, using your first submitted attempt. Later retries do not
            change this mark.
          </p>
        </div>
        <button className="button secondary" disabled={disabled} onClick={onReview}>
          Review questions
        </button>
      </div>
      <div className="results-overview">
        <div className="results-total">
          <span className="score-label">Final mark</span>
          <strong data-testid="final-mark">
            {result.correct} / {result.total}
          </strong>
          <span className="score-subtext">marks earned</span>
        </div>
        <div className="results-total">
          <span className="score-label">Percentage</span>
          <strong data-testid="final-percentage">{result.percentage}%</strong>
          <span className="score-subtext">of all scorable questions</span>
        </div>
      </div>
      <p className="result-completion">
        <strong>{result.attempted} submitted</strong> · <span>{result.unanswered} unanswered</span>
      </p>
      {result.unanswered > 0 && (
        <div className="result-unanswered">
          <p>
            Unsubmitted drafts and unscored reveals earn no marks. You can return to submit
            unanswered questions, then view your updated result.
          </p>
          <button className="button" disabled={disabled} onClick={onUnanswered}>
            Continue unanswered questions
          </button>
        </div>
      )}
      {result.excluded > 0 && (
        <p className="source-review">
          {result.excluded} source-review {result.excluded === 1 ? "question is" : "questions are"}{" "}
          excluded from the score and total.
        </p>
      )}
      <p className="question-help">
        First attempts: {result.independent} independent · {result.assisted} assisted ·{" "}
        {result.review} after seeing the source answer. This is a practice score, not an official
        exam result.
      </p>
      <div className="category-results">
        <h3>Marks by domain</h3>
        <ul className="result-domain-list">
          {result.domains.map((domain) => (
            <li key={domain.name}>
              <span>
                {domain.name}
                <small>
                  {domain.attempted} of {domain.total} submitted
                </small>
              </span>
              <strong>
                {domain.correct} / {domain.total}
              </strong>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
