"use client";

import { useRef, useState } from "react";

export default function RestartExam({
  disabled,
  onRestart,
}: {
  disabled: boolean;
  onRestart: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onRestart();
      dialog.current?.close();
      // Closing a dialog restores its trigger; move focus to the new question afterward.
      setTimeout(() => document.getElementById("active-question")?.focus(), 0);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button
        className="button secondary"
        disabled={disabled || pending}
        onClick={() => {
          setError("");
          dialog.current?.showModal();
        }}
      >
        Restart exam
      </button>
      <dialog
        ref={dialog}
        className="restart-dialog"
        aria-labelledby="restart-exam-title"
        aria-describedby="restart-exam-description"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 id="restart-exam-title">Restart this exam?</h2>
        <p id="restart-exam-description">
          Clear this exam’s answers, scores, drafts, and Chiikawa conversations and start again at
          question one. Teaching preferences saved from those conversations will also be removed.
          Timed practice restarts with the full time limit. Other exams keep their progress.
        </p>
        {error && (
          <p className="tutor-error" role="alert">
            {error}
          </p>
        )}
        <div className="progress-actions">
          <button
            className="button secondary"
            autoFocus
            disabled={pending}
            onClick={() => dialog.current?.close()}
          >
            Keep my progress
          </button>
          <button className="button" disabled={disabled || pending} onClick={() => void confirm()}>
            {pending ? "Restarting…" : "Restart from question 1"}
          </button>
        </div>
      </dialog>
    </>
  );
}
