"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PracticeResults from "./PracticeResults";
import type { Answer, Question } from "../lib/types";
import type {
  DraftState,
  PracticeSnapshot,
  Recommendation,
  TutorIntent,
} from "../lib/practice-types";

const emptyState = (): DraftState => ({
  selectedKeys: [],
  reasoning: "",
  generation: 0,
  revision: 0,
  hintCount: 0,
  submitted: false,
  exposed: false,
  visible: false,
  result: null,
});
async function api<T>(
  url: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data as T;
}
type TutorReply = {
  message: string;
  concept: string;
  nextStep: string;
  runId: string;
  state: DraftState;
};
type CoachProps = {
  question: Question;
  initial: DraftState;
  certification: string;
  onRefresh: () => Promise<void>;
  onNavigate: (key: string) => void;
  onBusy: (busy: boolean) => void;
};

function QuestionCoach({
  question,
  initial,
  certification,
  onRefresh,
  onNavigate,
  onBusy,
}: CoachProps) {
  const [state, setState] = useState(initial);
  const stateRef = useRef(initial);
  const initialRef = useRef(initial);
  const [selected, setSelected] = useState(initial.selectedKeys);
  const [reasoning, setReasoning] = useState(initial.reasoning);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(initial.visible);
  const [saving, setSaving] = useState(false);
  const [tutorBusy, setTutorBusy] = useState(false);
  const [tutorError, setTutorError] = useState("");
  const [reply, setReply] = useState<TutorReply | null>(null);
  const [input, setInput] = useState("");
  const [related, setRelated] = useState<Recommendation[]>([]);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const epoch = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const failedSave = useRef(false);
  const submission = useRef<string | null>(null);
  const tutorPanel = useRef<HTMLDivElement>(null);
  const setServerState = useCallback((next: DraftState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const cancelTutor = useCallback(() => {
    epoch.current += 1;
    controller.current?.abort();
    setTutorBusy(false);
    setReply(null);
    setTutorError("");
  }, []);

  useEffect(() => {
    onBusy(busy || saving);
  }, [busy, saving, onBusy]);
  useEffect(() => {
    alive.current = true;
    // Re-entry starts hidden, even if this question was revealed on an earlier visit.
    async function restore() {
      try {
        if (initialRef.current.visible) {
          const data = await api<{ state: DraftState }>(
            `/api/questions/${question.id}/answer`,
            undefined,
            "DELETE",
          );
          if (alive.current) setServerState(data.state);
        }
        const data = await api<{ recommendations: Recommendation[] }>(
          `/api/practice?certification=${encodeURIComponent(certification)}&questionId=${question.id}`,
        );
        if (alive.current) setRelated(data.recommendations);
      } catch (cause) {
        if (alive.current) setError((cause as Error).message);
      } finally {
        if (alive.current) setBusy(false);
      }
    }
    void restore();
    return () => {
      alive.current = false;
      epoch.current += 1;
      controller.current?.abort();
    };
  }, [question.id, certification, setServerState]);
  useEffect(() => {
    if (reply) tutorPanel.current?.focus();
  }, [reply]);

  function save(nextSelected: string[], nextReasoning: string) {
    cancelTutor();
    setError("");
    pendingSaves.current += 1;
    setSaving(true);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (failedSave.current) throw new Error("Reload progress to resolve the unsaved change.");
        const data = await api<{ state: DraftState }>("/api/practice", {
          action: "draft",
          certification,
          questionId: question.id,
          selectedKeys: nextSelected,
          reasoning: nextReasoning,
          revision: stateRef.current.revision,
        });
        if (alive.current) setServerState(data.state);
      })
      .catch((cause) => {
        failedSave.current = true;
        if (alive.current) setError((cause as Error).message);
      })
      .finally(() => {
        pendingSaves.current -= 1;
        if (alive.current) setSaving(pendingSaves.current > 0);
      });
  }
  function choose(key: string) {
    const next =
      question.type === "multiple_response"
        ? selected.includes(key)
          ? selected.filter((item) => item !== key)
          : [...selected, key]
        : [key];
    setSelected(next);
    save(next, reasoning);
  }
  function match(item: string, key: string) {
    const next = [
      ...selected.filter((value) => !value.startsWith(`${item}:`)),
      ...(key ? [`${item}:${key}`] : []),
    ];
    setSelected(next);
    save(next, reasoning);
  }
  async function act(action: "submit" | "reveal" | "hide" | "retry") {
    cancelTutor();
    setBusy(true);
    setError("");
    try {
      await queue.current;
      if (failedSave.current)
        throw new Error("Your latest changes were not saved. Reload progress before continuing.");
      if (action === "submit" || action === "retry") {
        if (action === "submit") submission.current ??= crypto.randomUUID();
        const data = await api<{
          state: DraftState;
          answer?: Answer;
          recommendations?: Recommendation[];
        }>("/api/practice", {
          action,
          certification,
          questionId: question.id,
          requestId: submission.current,
          revision: stateRef.current.revision,
        });
        if (!alive.current) return;
        setServerState(data.state);
        setSelected(data.state.selectedKeys);
        setReasoning(data.state.reasoning);
        setAnswer(data.answer ?? null);
        if (data.recommendations) setRelated(data.recommendations);
        if (action === "retry") submission.current = null;
      } else if (action === "reveal") {
        const data = await api<Answer>(`/api/questions/${question.id}/answer`, undefined, "POST");
        const updated = await api<{ state: DraftState }>(
          `/api/practice?certification=${encodeURIComponent(certification)}&questionId=${question.id}`,
        );
        if (!alive.current) return;
        setAnswer(data);
        setServerState(updated.state);
      } else {
        const data = await api<{ state: DraftState }>(
          `/api/questions/${question.id}/answer`,
          undefined,
          "DELETE",
        );
        if (!alive.current) return;
        setAnswer(null);
        setServerState(data.state);
      }
      await onRefresh();
    } catch (cause) {
      if (alive.current) setError((cause as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function ask(intent: TutorIntent, message: string) {
    if (tutorBusy) return;
    setTutorBusy(true);
    setTutorError("");
    const version = ++epoch.current;
    controller.current?.abort();
    controller.current = new AbortController();
    try {
      await queue.current;
      if (failedSave.current) throw new Error("Reload progress before asking the tutor.");
      const data = await api<TutorReply>(
        "/api/tutor",
        {
          questionId: question.id,
          requestId: crypto.randomUUID(),
          intent,
          message,
          revision: stateRef.current.revision,
        },
        "POST",
        controller.current.signal,
      );
      if (!alive.current || version !== epoch.current) return;
      setReply(data);
      setServerState(data.state);
      setInput("");
    } catch (cause) {
      if (alive.current && version === epoch.current && (cause as Error).name !== "AbortError")
        setTutorError((cause as Error).message);
    } finally {
      if (alive.current && version === epoch.current) setTutorBusy(false);
    }
  }
  const required =
    question.type === "scenario_matching" ? question.matchItems.length : question.selectionCount;
  const complete = selected.length === required;
  const locked =
    busy || state.submitted || Boolean(answer) || state.visible || question.reviewRequired;
  return (
    <article
      className="question-card"
      aria-labelledby="active-question"
      id={`question-${question.sourceKey}`}
    >
      <div className="question-head">
        <span className="question-id">{question.sourceKey}</span>
        <span className="question-type">
          {question.type.replace(/_/g, " ")} ·{" "}
          {question.type === "scenario_matching" ? `match ${required} items` : `select ${required}`}
        </span>
      </div>
      <h2 id="active-question" className="question-prompt" tabIndex={-1}>
        {question.prompt}
      </h2>
      <p className="question-help">
        {[question.domainName, question.scenarioTitle].filter(Boolean).join(" · ")}
        {question.sourcePage ? ` · PDF page ${question.sourcePage}` : ""}
      </p>
      {question.scenarioDescription && (
        <details className="scenario-context">
          <summary>Read the scenario</summary>
          <p>{question.scenarioDescription}</p>
        </details>
      )}
      {question.reviewRequired && (
        <div className="source-review" role="note">
          <strong>Source review required — excluded from scoring and coaching</strong>
          <p>{question.reviewNote}</p>
        </div>
      )}
      <fieldset className="answer-options" disabled={locked} aria-describedby="selection-help">
        <legend className="sr-only">Your answer</legend>
        {question.type === "scenario_matching" ? (
          question.matchItems.map((item) => (
            <div className="match-item" key={item.key}>
              <label htmlFor={`match-${item.key}`}>{item.text}</label>
              <select
                id={`match-${item.key}`}
                className="match-select"
                value={selected.find((key) => key.startsWith(`${item.key}:`))?.split(":")[1] ?? ""}
                onChange={(event) => match(item.key, event.target.value)}
              >
                <option value="">Choose an option…</option>
                {question.options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.text}
                  </option>
                ))}
              </select>
              {answer && (
                <p className="correct-hint">
                  Source pairing:{" "}
                  {answer.correctKeys
                    .filter((key) => key.startsWith(`${item.key}:`))
                    .map(
                      (key) =>
                        question.options.find((option) => option.key === key.split(":")[1])?.text,
                    )
                    .join(", ")}
                </p>
              )}
            </div>
          ))
        ) : (
          <div className="option-list">
            {question.options.map((option) => {
              const correct = answer?.correctKeys.includes(option.key);
              const wrong = answer && selected.includes(option.key) && !correct;
              return (
                <label
                  className={`question-option ${correct ? "option-correct" : ""} ${wrong ? "option-wrong" : ""}`}
                  key={option.key}
                >
                  <input
                    type={question.type === "single_choice" ? "radio" : "checkbox"}
                    name={`answer-${question.id}`}
                    checked={selected.includes(option.key)}
                    disabled={
                      question.type === "multiple_response" &&
                      !selected.includes(option.key) &&
                      selected.length >= required
                    }
                    onChange={() => choose(option.key)}
                  />
                  <span className="option-marker">{option.key}</span>
                  <span className="option-text">{option.text}</span>
                  {correct && <span className="answer-status">✓ Source answer</span>}
                  {wrong && <span className="answer-status">× Your selection</span>}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>
      <p id="selection-help" className="question-help">
        {state.submitted
          ? "Attempt recorded. Start a retry to answer again."
          : `${selected.length} of ${required} selected. ${complete ? "Ready to submit." : "Complete every required selection to submit."}`}
      </p>
      <div className="reasoning-input">
        <label htmlFor="reasoning">
          Your reasoning <span>(optional)</span>
        </label>
        <textarea
          id="reasoning"
          maxLength={1000}
          rows={2}
          disabled={locked}
          value={reasoning}
          onChange={(event) => {
            setReasoning(event.target.value);
            save(selected, event.target.value);
          }}
          placeholder="What led you to this answer?"
        />
        <small role="status">
          {saving
            ? "Saving…"
            : error
              ? "Changes may not be saved"
              : "Progress saved in this browser for 30 days"}
        </small>
      </div>
      {state.exposed && !state.submitted && !question.reviewRequired && (
        <p className="question-help">
          You have seen this source answer. Future attempts count as review practice.
        </p>
      )}
      {error && (
        <div className="tutor-error" role="alert">
          <p>{error}</p>
          <button className="button secondary" onClick={() => window.location.reload()}>
            Reload progress
          </button>
        </div>
      )}
      <div className="question-actions">
        <div className="question-buttons">
          {!state.submitted && !state.exposed && (
            <button
              className="button"
              disabled={busy || saving || !complete || Boolean(answer) || question.reviewRequired}
              onClick={() => void act("submit")}
            >
              Submit and reveal
            </button>
          )}
          {!state.submitted && state.exposed && !state.visible && !answer && (
            <button
              className="button"
              disabled={busy || saving || !complete || question.reviewRequired}
              onClick={() => void act("submit")}
            >
              Submit retry and reveal
            </button>
          )}
          <button
            className="toggle"
            disabled={busy || saving}
            onClick={() => void act(answer ? "hide" : "reveal")}
          >
            {answer
              ? "Hide answer"
              : state.submitted
                ? "Show source answer"
                : "Reveal without answering"}
          </button>
          {(state.submitted || state.exposed) && !question.reviewRequired && (
            <button
              className="button secondary"
              disabled={busy || saving}
              onClick={() => void act("retry")}
            >
              Try again
            </button>
          )}
        </div>
      </div>
      {answer && (
        <section className="answer-panel" aria-label="Source answer" aria-live="polite">
          <h3>
            {question.reviewRequired
              ? "Disputed source answer — unscored"
              : state.result
                ? `${state.result.correct ? "Correct" : "Incorrect"} · ${state.result.kind} attempt`
                : "Source answer · unscored reveal"}
          </h3>
          <div className="answer-list">
            {answer.correctKeys.map((key) => (
              <span className="answer-chip" key={key}>
                {key}
              </span>
            ))}
          </div>
          <p>{answer.rationale}</p>
          {answer.reviewNote && <p className="source-review">{answer.reviewNote}</p>}
        </section>
      )}
      {!question.reviewRequired && (
        <section className="coach-section" aria-label="AI question coach">
          <h3>Your question coach</h3>
          <p className="tutor-note">
            {answer
              ? "Explore the source rationale and your reasoning. AI commentary may be imperfect."
              : "Get conceptual guidance while keeping the source answer hidden."}
          </p>
          <div className="coach-actions">
            {!answer && (
              <button
                className="tutor-button"
                disabled={busy || saving || tutorBusy}
                onClick={() =>
                  void ask(
                    "hint",
                    "Give me the next conceptual hint without identifying an answer.",
                  )
                }
              >
                {state.hintCount
                  ? `Next hint · stage ${Math.min(state.hintCount + 1, 3)}/3`
                  : "Get a hint"}
              </button>
            )}
            <button
              className="tutor-button"
              disabled={busy || saving || tutorBusy}
              onClick={() =>
                void ask("concept", "Explain the underlying concept using a neutral example.")
              }
            >
              Explain the concept
            </button>
            {answer && (
              <button
                className="tutor-button"
                disabled={busy || saving || tutorBusy}
                onClick={() =>
                  void ask(
                    "review",
                    "Explain the source rationale and help me understand my reasoning and the distractors where supported.",
                  )
                }
              >
                Review my answer
              </button>
            )}
          </div>
          {tutorBusy && (
            <p className="tutor-state" role="status">
              Thinking through the concept…
            </p>
          )}
          {tutorError && (
            <p className="tutor-error" role="alert">
              {tutorError}
            </p>
          )}
          {reply && (
            <div className="tutor-panel" ref={tutorPanel} tabIndex={-1} aria-label="AI commentary">
              <p className="eyebrow">AI commentary</p>
              <p className="tutor-message">{reply.message}</p>
              <div className="tutor-detail">
                <strong>Concept</strong>
                <p>{reply.concept}</p>
              </div>
              <div className="tutor-detail">
                <strong>Next step</strong>
                <p>{reply.nextStep}</p>
              </div>
            </div>
          )}
          <form
            className="tutor-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask("follow_up", input.trim());
            }}
          >
            <label htmlFor="follow-up">Ask a follow-up</label>
            <div>
              <textarea
                id="follow-up"
                value={input}
                maxLength={1000}
                rows={2}
                onChange={(event) => setInput(event.target.value)}
              />
              <button className="button" disabled={busy || saving || tutorBusy || !input.trim()}>
                Send
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="related-practice">
        <h3>Practice next</h3>
        {related.length ? (
          <ul>
            {related.map((item) => (
              <li key={item.sourceKey}>
                <button
                  className="related-link"
                  disabled={busy || saving}
                  onClick={() => onNavigate(item.sourceKey)}
                >
                  <strong>{item.sourceKey}</strong> — {item.reason}
                  <span>{item.prompt}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="question-help">
            No new questions or unresolved mistakes remain. Use the question navigator to revisit a
            topic.
          </p>
        )}
      </section>
    </article>
  );
}

export default function PracticeClient({
  questions,
  timeLimitMinutes,
  certification,
}: {
  questions: Question[];
  timeLimitMinutes: number | null;
  certification: string;
}) {
  const [snapshot, setSnapshot] = useState<PracticeSnapshot | null>(null);
  const [index, setIndex] = useState(0);
  const [timed, setTimed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const onBusy = useCallback((value: boolean) => setChildBusy(value), []);
  const refresh = useCallback(async () => {
    const next = await api<PracticeSnapshot>(
      `/api/practice?certification=${encodeURIComponent(certification)}`,
    );
    setSnapshot(next);
  }, [certification]);
  useEffect(() => {
    let active = true;
    api<PracticeSnapshot>(`/api/practice?certification=${encodeURIComponent(certification)}`)
      .then((data) => {
        if (!active) return;
        setSnapshot(data);
        const requested = new URL(window.location.href).searchParams.get("question");
        const savedIndex = questions.findIndex(
          (question) => question.sourceKey === (requested || data.settings.questionKey),
        );
        setIndex(Math.max(0, savedIndex));
        setShowResults(
          data.settings.started &&
            new URL(window.location.href).searchParams.get("view") === "results",
        );
      })
      .catch((cause) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [certification, questions]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function navigate(key: string) {
    const nextIndex = questions.findIndex((question) => question.sourceKey === key);
    if (nextIndex < 0 || busy || childBusy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ snapshot: PracticeSnapshot }>("/api/practice", {
        action: "navigate",
        certification,
        sourceKey: key,
      });
      setSnapshot(data.snapshot);
      setIndex(nextIndex);
      setShowResults(false);
      setGeneration((value) => value + 1);
      const url = new URL(window.location.href);
      url.searchParams.set("question", key);
      url.searchParams.delete("view");
      window.history.replaceState(null, "", url);
      setTimeout(() => document.getElementById("active-question")?.focus(), 0);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    try {
      const data = await api<{ snapshot: PracticeSnapshot }>("/api/practice", {
        action: "start",
        certification,
        timed,
      });
      setSnapshot(data.snapshot);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finish() {
    if (busy || childBusy) return;
    setBusy(true);
    setError("");
    try {
      // Fetch saved grades again so the last submission is included in the mark.
      await refresh();
      setShowResults(true);
      const url = new URL(window.location.href);
      url.searchParams.set("view", "results");
      url.searchParams.set("question", questions[index].sourceKey);
      window.history.replaceState(null, "", url);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
      setChildBusy(false);
    }
  }
  function reviewQuestions() {
    setShowResults(false);
    setReviewOnly(false);
    setChildBusy(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
    setTimeout(() => document.getElementById("active-question")?.focus(), 0);
  }
  async function reset() {
    setBusy(true);
    setGeneration((value) => value + 1);
    try {
      await api("/api/practice", undefined, "DELETE");
      await refresh();
      setIndex(0);
      setReviewOnly(false);
      setShowResults(false);
      setConfirmReset(false);
      setError("");
      const url = new URL(window.location.href);
      url.searchParams.delete("question");
      url.searchParams.delete("view");
      window.history.replaceState(null, "", url);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!questions.length)
    return <div className="empty-state">This certification has no questions available yet.</div>;
  if (!snapshot)
    return (
      <div className="empty-state" role={error ? "alert" : "status"}>
        {error || "Loading your learning progress…"}
        {error && (
          <button className="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        )}
      </div>
    );
  const progress = snapshot.progress;
  const remaining = snapshot.settings.deadline
    ? Math.max(0, Math.ceil((snapshot.settings.deadline - now) / 1000))
    : null;
  const visibleQuestions = reviewOnly
    ? questions.filter((question) => snapshot.mistakeKeys.includes(question.sourceKey))
    : questions;
  const current = questions[index];
  const visibleIndex = visibleQuestions.findIndex((question) => question.id === current.id);
  const isLastQuestion = visibleIndex >= visibleQuestions.length - 1;
  if (showResults)
    return (
      <>
        {error && (
          <p className="tutor-error" role="alert">
            {error}
          </p>
        )}
        <PracticeResults
          result={snapshot.result}
          disabled={busy}
          onReview={reviewQuestions}
          onUnanswered={() => {
            setReviewOnly(false);
            const key = snapshot.result.unansweredKeys[0];
            if (key) void navigate(key);
          }}
        />
        <p className="disclaimer">
          Independent practice content; not official live-exam content. Questions flagged for source
          review are excluded from the mark.
        </p>
      </>
    );
  return (
    <>
      {error && (
        <p className="tutor-error" role="alert">
          {error}
        </p>
      )}
      <section className="learning-summary" aria-label="Learning progress">
        <div className="score-strip">
          <div>
            <span className="score-label">Questions attempted</span>
            <strong>
              {progress.attempted} /{" "}
              {questions.filter((question) => !question.reviewRequired).length}
            </strong>
            <span className="score-subtext">Unscored reveals excluded</span>
          </div>
          <div>
            <span className="score-label">Independent first attempts</span>
            <strong>
              {progress.independent
                ? `${Math.round((progress.independentCorrect / progress.independent) * 100)}%`
                : "—"}
            </strong>
            <span className="score-subtext">
              {progress.independent
                ? `${progress.independentCorrect} correct of ${progress.independent} attempts`
                : "No independent attempts yet"}
            </span>
          </div>
          <div>
            <span className="score-label">Supported learning</span>
            <strong>{progress.assisted} assisted</strong>
            <span className="score-subtext">
              {progress.reviewCorrect} correct of {progress.reviews} review attempts
            </span>
          </div>
        </div>
        <details>
          <summary>Progress by domain</summary>
          <ul className="domain-progress">
            {progress.domains.map((domain) => (
              <li key={domain.name}>
                <strong>{domain.name}</strong>
                <span>
                  {domain.attempted} attempted ·{" "}
                  {domain.independent
                    ? `${domain.correct}/${domain.independent} independent correct`
                    : "No independent attempts yet"}
                </span>
              </li>
            ))}
          </ul>
        </details>
        <div className="progress-actions">
          {snapshot.settings.started && (snapshot.result.unanswered === 0 || remaining === 0) && (
            <button className="button" disabled={busy || childBusy} onClick={() => void finish()}>
              View results
            </button>
          )}
          <button
            className="button secondary"
            disabled={
              busy || childBusy || !snapshot.settings.started || !snapshot.mistakeKeys.length
            }
            onClick={() => {
              setReviewOnly(!reviewOnly);
              if (!reviewOnly) void navigate(snapshot.mistakeKeys[0]);
            }}
          >
            {reviewOnly ? "All questions" : `Review mistakes (${snapshot.mistakeKeys.length})`}
          </button>
          <button
            className="text-button"
            disabled={busy || childBusy}
            onClick={() => setConfirmReset(!confirmReset)}
          >
            Reset learning progress
          </button>
        </div>
        {confirmReset && (
          <div className="reset-confirm" role="group" aria-label="Confirm progress reset">
            <p>
              Delete all progress and tutor conversations for every certification in this browser?
            </p>
            <button className="button" disabled={busy || childBusy} onClick={() => void reset()}>
              Delete my progress
            </button>
            <button className="button secondary" onClick={() => setConfirmReset(false)}>
              Keep learning
            </button>
          </div>
        )}
        <p className="question-help">
          Anonymous progress expires {new Date(snapshot.expiresAt).toLocaleDateString()}. Clearing
          cookies loses access. No login required.
        </p>
      </section>
      {!snapshot.settings.started ? (
        <section className="timer-setup">
          <p className="eyebrow">Set your pace</p>
          <h2>Practice with your question coach</h2>
          <p>Try each question, ask for hints, then reveal the source answer and learn from it.</p>
          <div className="timer-choices">
            <label className={`timer-choice ${!timed ? "selected" : ""}`}>
              <input type="radio" name="timer" checked={!timed} onChange={() => setTimed(false)} />
              <span>
                <strong>Untimed study</strong>
                <small>Learn at your own pace</small>
              </span>
            </label>
            <label className={`timer-choice ${timed ? "selected" : ""}`}>
              <input type="radio" name="timer" checked={timed} onChange={() => setTimed(true)} />
              <span>
                <strong>Timed practice</strong>
                <small>{timeLimitMinutes ?? 120} minutes · coaching stays available</small>
              </span>
            </label>
          </div>
          <button className="button" disabled={busy} onClick={() => void start()}>
            Start practice
          </button>
        </section>
      ) : (
        <>
          <div className={`timer-bar ${remaining === 0 ? "timer-expired" : ""}`}>
            <span>
              {remaining === null
                ? "Untimed study"
                : remaining === 0
                  ? "Time expired · continue reviewing at your own pace"
                  : "Practice timer"}
            </span>
            {remaining !== null && remaining > 0 && (
              <strong role="timer" aria-label="Time remaining">
                {Math.floor(remaining / 60)
                  .toString()
                  .padStart(2, "0")}
                :{(remaining % 60).toString().padStart(2, "0")}
              </strong>
            )}
          </div>
          <nav className="question-navigation" aria-label="Question navigation">
            <label htmlFor="question-nav">
              Question {index + 1} of {questions.length}
            </label>
            <select
              id="question-nav"
              value={current.sourceKey}
              disabled={busy || childBusy}
              onChange={(event) => void navigate(event.target.value)}
            >
              {visibleQuestions.map((question) => (
                <option key={question.sourceKey} value={question.sourceKey}>
                  {question.ordinal}. {question.sourceKey}
                  {question.reviewRequired ? " · source review" : ""}
                </option>
              ))}
            </select>
          </nav>
          {reviewOnly && !visibleQuestions.length ? (
            <div className="empty-state">
              No unresolved mistakes remain. Switch to all questions to continue.
            </div>
          ) : (
            !busy && (
              <QuestionCoach
                key={`${current.sourceKey}-${generation}`}
                question={current}
                initial={snapshot.states[current.sourceKey] ?? emptyState()}
                certification={certification}
                onRefresh={refresh}
                onNavigate={(key) => {
                  setReviewOnly(false);
                  void navigate(key);
                }}
                onBusy={onBusy}
              />
            )
          )}
          <nav className="pagination" aria-label="Previous and next question">
            <button
              className="button secondary"
              disabled={
                busy ||
                childBusy ||
                visibleQuestions.findIndex((question) => question.id === current.id) <= 0
              }
              onClick={() =>
                void navigate(
                  visibleQuestions[
                    visibleQuestions.findIndex((question) => question.id === current.id) - 1
                  ].sourceKey,
                )
              }
            >
              ← Previous
            </button>
            <button
              className="button"
              disabled={busy || childBusy}
              onClick={() =>
                isLastQuestion || !visibleQuestions.length
                  ? void finish()
                  : void navigate(visibleQuestions[visibleIndex + 1].sourceKey)
              }
            >
              {isLastQuestion || !visibleQuestions.length ? "Finish and view results" : "Next →"}
            </button>
          </nav>
        </>
      )}
      <p className="disclaimer">
        Independent practice content; not official live-exam content. Source answers remain
        authoritative except where flagged for review. AI commentary does not guarantee a pass.
      </p>
    </>
  );
}
