import ChiikawaMemory from "./ChiikawaMemory";
import type { PreferenceKey } from "../lib/tutor-memory-types";
import TutorResponse, { type TutorActivity, type TutorText } from "./TutorResponse";
import type { TutorIntent } from "../lib/practice-types";

type Props = {
  questionId: number;
  memoryVersion: string;
  onForget: (key?: PreferenceKey) => Promise<void>;
  unavailable: boolean;
  revealed: boolean;
  hintCount: number;
  disabled: boolean;
  streaming: boolean;
  status: string;
  error: string;
  text: TutorText;
  activities: TutorActivity[];
  input: string;
  onInput: (value: string) => void;
  onAsk: (intent: TutorIntent, message: string) => void;
  onStop: () => void;
};

// Presentation only: one question controller owns the request across all viewport sizes.
export default function ChiikawaPanel({
  questionId,
  memoryVersion,
  onForget,
  unavailable,
  revealed,
  hintCount,
  disabled,
  streaming,
  status,
  error,
  text,
  activities,
  input,
  onInput,
  onAsk,
  onStop,
}: Props) {
  return (
    <aside className="chiikawa-panel" aria-labelledby="chiikawa-heading">
      <header className="chiikawa-header">
        <h2 id="chiikawa-heading" tabIndex={-1}>
          Chiikawa
        </h2>
        <p>Your AI study companion</p>
        <button
          className="text-button companion-shortcut"
          onClick={() => document.getElementById("active-question")?.focus()}
        >
          Back to question
        </button>
      </header>
      {unavailable ? (
        <p className="source-review" role="note">
          Chiikawa is unavailable while this question is flagged for source review. You can still
          inspect the source answer and its discrepancy.
        </p>
      ) : (
        <>
          <p className="tutor-note">
            {revealed
              ? "Explore the source rationale and your reasoning. AI commentary may be imperfect."
              : "Get conceptual guidance while keeping the source answer hidden."}
          </p>
          <div className="coach-actions">
            {!revealed && (
              <button
                className="tutor-button"
                disabled={disabled || streaming}
                onClick={() =>
                  onAsk("hint", "Give me the next conceptual hint without identifying an answer.")
                }
              >
                {hintCount ? `Next hint · stage ${Math.min(hintCount + 1, 3)}/3` : "Get a hint"}
              </button>
            )}
            <button
              className="tutor-button"
              disabled={disabled || streaming}
              onClick={() =>
                onAsk("concept", "Explain the underlying concept using a neutral example.")
              }
            >
              Explain the concept
            </button>
            {revealed && (
              <button
                className="tutor-button"
                disabled={disabled || streaming}
                onClick={() =>
                  onAsk(
                    "review",
                    "Explain the source rationale and help me understand my reasoning and the distractors where supported.",
                  )
                }
              >
                Review my answer
              </button>
            )}
          </div>
          <div className="tutor-stream-status">
            <p className="tutor-state" role="status" aria-live="polite" aria-atomic="true">
              {status}
            </p>
            {streaming && (
              <button className="button secondary" onClick={onStop}>
                Stop response
              </button>
            )}
          </div>
          <div
            className="chiikawa-content"
            role="region"
            aria-label="Chiikawa conversation"
            tabIndex={0}
          >
            {error && (
              <p className="tutor-error" role="alert">
                {error}
              </p>
            )}
            {(Object.keys(text).length > 0 || activities.length > 0) && (
              <TutorResponse text={text} activities={activities} streaming={streaming} />
            )}
          </div>
          <form
            className="tutor-form"
            onSubmit={(event) => {
              event.preventDefault();
              onAsk("follow_up", input.trim());
            }}
          >
            <label htmlFor="follow-up">Ask Chiikawa a follow-up</label>
            <div>
              <textarea
                id="follow-up"
                value={input}
                maxLength={1000}
                rows={2}
                onChange={(event) => onInput(event.target.value)}
              />
              <button className="button" disabled={disabled || streaming || !input.trim()}>
                Send
              </button>
            </div>
          </form>
          <ChiikawaMemory
            key={`${questionId}-${revealed}`}
            version={memoryVersion}
            questionId={questionId}
            disabled={disabled}
            onForget={onForget}
          />
        </>
      )}
    </aside>
  );
}
