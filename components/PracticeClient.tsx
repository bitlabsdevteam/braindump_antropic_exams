"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PracticeResults from "./PracticeResults";
import PracticeScore from "./PracticeScore";
import RestartExam from "./RestartExam";
import { activityLabel, type TutorActivity, type TutorText } from "./TutorResponse";
import ChiikawaPanel from "./ChiikawaPanel";
import { readTutorStream } from "../lib/read-tutor-stream";
import type { TutorStreamReply } from "../lib/tutor-stream-types";
import type { Answer, Question } from "../lib/types";
import type {
  DraftState,
  PracticeSnapshot,
  PracticeResult,
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
type CoachProps = {
  question: Question;
  initial: DraftState;
  certification: string;
  onRefresh: () => Promise<void>;
  onSnapshot: (snapshot: PracticeSnapshot) => void;
  practiceResult: PracticeResult;
  onNavigate: (key: string) => void;
  onBusy: (busy: boolean) => void;
};

function QuestionCoach({
  question,
  initial,
  certification,
  onRefresh,
  onSnapshot,
  practiceResult,
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
  const [reply, setReply] = useState<TutorStreamReply | null>(null);
  const [partial, setPartial] = useState<TutorText>({});
  const [activities, setActivities] = useState<TutorActivity[]>([]);
  const [tutorStatus, setTutorStatus] = useState("");
  const [input, setInput] = useState("");
  const [related, setRelated] = useState<Recommendation[]>([]);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const epoch = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const failedSave = useRef(false);
  const submission = useRef<string | null>(null);
  const setServerState = useCallback((next: DraftState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const cancelTutor = useCallback(() => {
    epoch.current += 1;
    controller.current?.abort();
    setTutorBusy(false);
    setReply(null);
    setPartial({});
    setActivities([]);
    setTutorStatus("");
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
          snapshot: PracticeSnapshot;
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
        onSnapshot(data.snapshot);
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
      if (action !== "submit" && action !== "retry") await onRefresh();
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
    setReply(null);
    setPartial({});
    setActivities([]);
    setTutorStatus("Connecting to Chiikawa…");
    const version = ++epoch.current;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const current = () => alive.current && version === epoch.current;
    let receiving = false;
    try {
      await queue.current;
      if (!current()) return;
      if (failedSave.current) throw new Error("Reload progress before asking Chiikawa.");
      const response = await fetch("/api/tutor", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        signal: requestController.signal,
        body: JSON.stringify({
          questionId: question.id,
          requestId: crypto.randomUUID(),
          intent,
          message,
          revision: stateRef.current.revision,
        }),
      });
      await readTutorStream(
        response,
        (event) => {
          if (!current()) return;
          switch (event.type) {
            case "start":
              setTutorStatus("Connected to Chiikawa.");
              break;
            case "activity":
              setActivities((previous) => [
                ...previous.filter((item) => item.id !== event.id),
                event,
              ]);
              setTutorStatus(activityLabel(event));
              break;
            case "delta":
              if (!receiving) {
                receiving = true;
                setTutorStatus("Receiving Chiikawa’s response…");
              }
              setPartial((previous) => ({
                ...previous,
                [event.field]: (previous[event.field] ?? "") + event.text,
              }));
              break;
            case "reset":
              receiving = false;
              setReply(null);
              setPartial({});
              setActivities([]);
              setTutorStatus("Chiikawa’s connection was interrupted. Retrying…");
              break;
            case "complete":
              setReply(event.reply);
              setPartial({});
              setServerState(event.reply.state);
              setInput("");
              setTutorStatus("Chiikawa’s response complete.");
              break;
            case "error":
              throw new Error(event.error);
          }
        },
        requestController.signal,
      );
    } catch (cause) {
      if (current()) {
        setReply(null);
        setPartial({});
        setActivities([]);
        setTutorStatus("");
        if ((cause as Error).name !== "AbortError") setTutorError((cause as Error).message);
      }
    } finally {
      if (current()) setTutorBusy(false);
    }
  }
  const required =
    question.type === "scenario_matching" ? question.matchItems.length : question.selectionCount;
  const complete = selected.length === required;
  const locked =
    busy || state.submitted || Boolean(answer) || state.visible || question.reviewRequired;
  return (
    <div className="question-workspace">
      <article
        className="question-card"
        aria-labelledby="active-question"
        id={`question-${question.sourceKey}`}
      >
        <button
          className="text-button companion-shortcut"
          onClick={() => document.getElementById("chiikawa-heading")?.focus()}
        >
          Ask Chiikawa
        </button>
        <div className="question-head">
          <span className="question-id">{question.sourceKey}</span>
          <span className="question-type">
            {question.type.replace(/_/g, " ")} ·{" "}
            {question.type === "scenario_matching"
              ? `match ${required} items`
              : `select ${required}`}
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
                  value={
                    selected.find((key) => key.startsWith(`${item.key}:`))?.split(":")[1] ?? ""
                  }
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
            {state.result && practiceResult.score.current !== null && (
              <p className="question-score" data-testid="question-score">
                Current practice estimate: <strong>{practiceResult.score.current} / 1,000</strong> ·{" "}
                {practiceResult.correct} correct of {practiceResult.attempted} submitted. 720
                reference · {practiceResult.unanswered ? "provisional" : "practice complete"}.
                {state.result.kind === "review" && " Retries keep the first submitted mark."}
              </p>
            )}
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
              No new questions or unresolved mistakes remain. Use the question navigator to revisit
              a topic.
            </p>
          )}
        </section>
      </article>
      <ChiikawaPanel
        questionId={question.id}
        memoryVersion={reply?.runId ?? ""}
        onForget={async (key) => {
          cancelTutor();
          setBusy(true);
          try {
            const data = await api<{ state: DraftState }>(
              "/api/tutor/memory",
              { questionId: question.id, ...(key ? { key } : {}) },
              "DELETE",
            );
            if (alive.current) setServerState(data.state);
            await onRefresh();
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
        unavailable={question.reviewRequired}
        revealed={Boolean(answer)}
        hintCount={state.hintCount}
        disabled={busy || saving}
        streaming={tutorBusy}
        status={tutorStatus}
        error={tutorError}
        text={reply ?? partial}
        activities={activities}
        input={input}
        onInput={setInput}
        onAsk={(intent, message) => void ask(intent, message)}
        onStop={() => {
          cancelTutor();
          setTutorStatus("Chiikawa’s response stopped. You can ask again.");
        }}
      />
    </div>
  );
}

export default function PracticeClient({
  questions,
  domains,
  timeLimitMinutes,
  certification,
}: {
  questions: Question[];
  domains: { number: number; name: string }[];
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
  async function restart() {
    setBusy(true); // Unmounting the question cancels any active Chiikawa stream.
    setError("");
    try {
      const data = await api<{ snapshot: PracticeSnapshot }>("/api/practice", {
        action: "restart",
        certification,
      });
      setSnapshot(data.snapshot);
      setNow(Date.now());
      setIndex(0);
      setGeneration((value) => value + 1);
      setReviewOnly(false);
      setShowResults(false);
      setConfirmReset(false);
      const url = new URL(window.location.href);
      url.searchParams.set("question", questions[0].sourceKey);
      url.searchParams.delete("view");
      window.history.replaceState(null, "", url);
    } finally {
      setBusy(false);
      setChildBusy(false);
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
        <div className="progress-actions">
          <RestartExam disabled={busy || childBusy} onRestart={restart} />
        </div>
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
        <PracticeScore result={snapshot.result} />
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
          {snapshot.settings.started && (
            <RestartExam disabled={busy || childBusy} onRestart={restart} />
          )}
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
              Delete all progress and Chiikawa conversations for every certification in this
              browser?
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
          <h2>Practice with Chiikawa</h2>
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
            <div className="navigation-field">
              <label htmlFor="domain-nav">Domain</label>
              <select
                id="domain-nav"
                value={current.domainNumber ?? ""}
                disabled={busy || childBusy}
                onChange={(event) => {
                  const first = questions.find(
                    (question) => question.domainNumber === Number(event.target.value),
                  );
                  if (first) {
                    setReviewOnly(false);
                    void navigate(first.sourceKey);
                  }
                }}
              >
                {current.domainNumber === null && <option value="">No domain assigned</option>}
                {domains.map((domain) => (
                  <option key={domain.number} value={domain.number}>
                    {domain.number}. {domain.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="navigation-field">
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
            </div>
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
                onSnapshot={setSnapshot}
                practiceResult={snapshot.result}
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
