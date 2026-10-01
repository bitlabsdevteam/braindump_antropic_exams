"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Answer, Question } from "../lib/types";

type TutorResponse = { message: string; concept: string; nextStep: string; runId: string; relatedQuestions: { id: number; sourceKey: string; prompt: string }[] };

function ResultMark({ correct, wrong }: { correct: boolean; wrong: boolean }) {
  if (correct) return <span className="result-mark result-correct" aria-label="Correct answer">✓</span>;
  if (wrong) return <span className="result-mark result-wrong" aria-label="Incorrect answer">×</span>;
  return null;
}

function sameAnswers(selected: string[], correct: string[]) {
  return selected.length === correct.length && selected.every((key) => correct.includes(key));
}

function ExamResults({ questions, results, onBack }: { questions: Question[]; results: Record<number, boolean>; onBack: () => void }) {
  const categories = Array.from(questions.reduce((groups, question) => {
    const key = question.domainName ?? "General";
    const group = groups.get(key) ?? { name: key, total: 0, earned: 0 };
    group.total += 1;
    if (results[question.id]) group.earned += 1;
    groups.set(key, group);
    return groups;
  }, new Map<string, { name: string; total: number; earned: number }>()).values());
  const totalMarks = questions.length;
  const earnedMarks = categories.reduce((sum, category) => sum + category.earned, 0);
  const overall = Math.round((earnedMarks / totalMarks) * 100);
  const earnedTotal = Math.max(earnedMarks, 1);
  let cursor = 0;
  const gradient = categories.map((category, index) => {
    const start = cursor;
    cursor += (category.earned / earnedTotal) * 100;
    return `${["#d95d32", "#596852", "#5579a5", "#a66b4d", "#8b709b", "#8a7448", "#3d8582", "#b04d55"][index % 8]} ${start}% ${cursor}%`;
  }).join(", ");
  return <section className="results-view" aria-labelledby="results-title"><div className="results-header"><div><p className="eyebrow">Exam complete</p><h2 id="results-title">Your practice result</h2><p>One mark per question. Exact answers only for multiple-response and matching questions.</p></div><button className="button secondary" type="button" onClick={onBack}>← Review questions</button></div><div className="results-overview"><div className="result-donut" style={{ background: earnedMarks ? `conic-gradient(${gradient})` : "var(--line)" }} aria-label={`${overall}% overall score`}><div><strong>{overall}%</strong><span>overall</span></div></div><div className="results-total"><span className="score-label">Total score</span><strong>{earnedMarks} / {totalMarks}</strong><span className="score-subtext">marks earned across {questions.length} questions</span></div></div><div className="category-results"><h3>Score by category</h3>{categories.map((category, index) => { const percentage = Math.round((category.earned / category.total) * 100); return <div className="category-row" key={category.name}><span className="category-swatch" style={{ background: ["#d95d32", "#596852", "#5579a5", "#a66b4d", "#8b709b", "#8a7448", "#3d8582", "#b04d55"][index % 8] }} /><span className="category-name">{category.name}</span><span className="category-score">{category.earned} / {category.total}</span><strong>{percentage}%</strong></div>; })}</div></section>;
}

function QuestionCard({ question, index, onResult }: { question: Question; index: number; onResult: (questionId: number, correct: boolean) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [tutorLoading, setTutorLoading] = useState(false);
  const [tutorError, setTutorError] = useState<string | null>(null);
  const [tutorInput, setTutorInput] = useState("");
  const [tutorResponse, setTutorResponse] = useState<TutorResponse | null>(null);
  const tutorPanelRef = useRef<HTMLDivElement>(null);
  const tutorRequestRef = useRef<AbortController | null>(null);
  const isMulti = question.type === "multiple_response";
  const correctKeys = answer?.correctKeys ?? [];

  async function reveal() {
    if (answer) {
      tutorRequestRef.current?.abort();
      await fetch(`/api/questions/${question.id}/answer`, { method: "DELETE", cache: "no-store" });
      setAnswer(null); setTutorResponse(null); return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/questions/${question.id}/answer`, { method: "POST", cache: "no-store" });
      if (response.ok) {
        const nextAnswer = await response.json() as Answer;
        setAnswer(nextAnswer);
        onResult(question.id, sameAnswers(selected, nextAnswer.correctKeys));
      } else setAnswer(null);
    } finally { setLoading(false); }
  }

  function update(key: string) {
    setSelected((current) => {
      const next = isMulti
        ? (current.includes(key) ? current.filter((item) => item !== key) : current.length < question.selectionCount ? [...current, key] : current)
        : [key];
      if (answer) onResult(question.id, sameAnswers(next, correctKeys));
      return next;
    });
  }

  function selectedMatch(itemKey: string) {
    return selected.find((key) => key.startsWith(`${itemKey}:`))?.split(":")[1] ?? "";
  }

  function updateMatch(itemKey: string, optionKey: string) {
    setSelected((current) => {
      const next = [...current.filter((key) => !key.startsWith(`${itemKey}:`)), ...(optionKey ? [`${itemKey}:${optionKey}`] : [])];
      if (answer) onResult(question.id, sameAnswers(next, correctKeys));
      return next;
    });
  }

  useEffect(() => {
    if (tutorResponse) tutorPanelRef.current?.focus();
  }, [tutorResponse]);

  async function askTutor(content = "Please assess my current answer and help me reason through this question.") {
    const message = content.trim();
    if (!message || tutorLoading) return;
    setTutorOpen(true);
    setTutorLoading(true);
    setTutorError(null);
    setTutorInput("");
    tutorRequestRef.current?.abort();
    const controller = new AbortController();
    tutorRequestRef.current = controller;
    try {
      const response = await fetch("/api/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, selectedKeys: selected, message, requestId: crypto.randomUUID() }), signal: controller.signal,
      });
      const body = await response.json() as Partial<TutorResponse> & { error?: string };
      if (!response.ok) throw new Error(body.error || "The tutor could not respond.");
      if (typeof body.message !== "string" || typeof body.concept !== "string" || typeof body.nextStep !== "string" || typeof body.runId !== "string" || !Array.isArray(body.relatedQuestions)) throw new Error("The tutor returned an invalid response.");
      setTutorResponse(body as TutorResponse);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setTutorError(error instanceof Error ? error.message : "The tutor could not respond.");
    } finally { if (tutorRequestRef.current === controller) { tutorRequestRef.current = null; setTutorLoading(false); } }
  }

  async function resetTutor() {
    tutorRequestRef.current?.abort();
    await fetch("/api/tutor", { method: "DELETE", cache: "no-store" });
    setTutorResponse(null); setTutorError(null); setTutorInput("");
  }

  return <article className="question-card" id={question.domainNumber ? `domain-${question.domainNumber}` : undefined}>
    <div className="question-head"><span className="question-id">{String(index + 1).padStart(2, "0")} / {question.sourceKey}</span><span className="question-type">{question.type.replace(/_/g, " ")} · select {question.selectionCount}</span></div>
    <p className="question-prompt">{question.prompt}</p>
    {question.type === "scenario_matching" ? <div className="option-list">{question.matchItems.map((item) => {
      const chosen = selectedMatch(item.key);
      const correct = correctKeys.find((key) => key.startsWith(`${item.key}:`))?.split(":")[1];
      return <div className="match-item" key={item.key}><p>{item.text}</p><div className={`match-control ${answer && chosen === correct ? "match-correct" : answer && chosen && chosen !== correct ? "match-wrong" : ""}`}><select className="match-select" aria-label={`Answer for matching item ${item.ordinal}`} value={chosen} onChange={(event) => updateMatch(item.key, event.target.value)}><option value="">Choose a pattern…</option>{question.options.map((option) => <option value={option.key} key={option.key}>{option.text}</option>)}</select><ResultMark correct={Boolean(answer && chosen && chosen === correct)} wrong={Boolean(answer && chosen && chosen !== correct)} /></div>{answer && correct && chosen !== correct && <p className="correct-hint">Correct: {question.options.find((option) => option.key === correct)?.text}</p>}</div>;
    })}</div> : <div className="option-list">{question.options.map((option) => {
      const correct = correctKeys.includes(option.key);
      const wrong = Boolean(answer && selected.includes(option.key) && !correct);
      return <label className={`question-option ${answer && correct ? "option-correct" : ""} ${wrong ? "option-wrong" : ""}`} key={option.key}><input type={isMulti ? "checkbox" : "radio"} name={`q-${question.id}`} checked={selected.includes(option.key)} onChange={() => update(option.key)} /><span className="option-marker">{option.key}</span><span className="option-text">{option.text}</span><ResultMark correct={Boolean(answer && correct)} wrong={wrong} /></label>;
    })}</div>}
    <div className="question-actions"><span className="question-help">{question.domainName ?? question.scenarioTitle ?? "Practice question"}</span><div className="question-buttons"><button className="tutor-button" type="button" onClick={() => { setTutorOpen(true); if (!tutorResponse && !tutorLoading) void askTutor(); }}>{tutorOpen ? "Tutor open" : "Ask AI Tutor"}</button><button className="toggle" type="button" onClick={reveal}>{loading ? "Checking…" : answer ? "Hide answer" : "Reveal answer"}</button></div></div>
    {answer && <div className="answer-panel" role="status"><h3>Answer key · 1 mark</h3><div className="answer-list">{answer.correctKeys.map((key) => <span className="answer-chip" key={key}>{key}</span>)}</div><p>{answer.rationale}</p></div>}
    {tutorOpen && <div className="tutor-panel" ref={tutorPanelRef} tabIndex={-1} aria-labelledby={`tutor-title-${question.id}`}>
      <div className="tutor-panel-head"><div><p className="eyebrow">AI study coach</p><h3 id={`tutor-title-${question.id}`}>AI Tutor explanation</h3></div><div><button className="tutor-close" type="button" onClick={() => void resetTutor()}>Reset</button><button className="tutor-close" type="button" onClick={() => setTutorOpen(false)}>Close</button></div></div>
      {!answer && <p className="tutor-note">Before the official answer is revealed, the tutor gives concept-level guidance without naming the answer.</p>}
      {tutorLoading && <p className="tutor-state" role="status" aria-live="polite">Thinking through this question…</p>}
      {tutorError && <div className="tutor-error" role="alert"><p>{tutorError}</p><button className="tutor-retry" type="button" onClick={() => void askTutor(tutorInput || "Please assess my current answer and help me reason through this question.")}>Try again</button></div>}
      {tutorResponse && <div className="tutor-response" role="status" aria-live="polite"><p className="tutor-message">{tutorResponse.message}</p><div className="tutor-detail"><strong>Concept</strong><p>{tutorResponse.concept}</p></div><div className="tutor-detail"><strong>Next step</strong><p>{tutorResponse.nextStep}</p></div>{tutorResponse.relatedQuestions.length > 0 && <div className="tutor-detail"><strong>Related practice</strong><ul>{tutorResponse.relatedQuestions.map((item) => <li key={item.id}>{item.sourceKey}: {item.prompt}</li>)}</ul></div>}</div>}
      <form className="tutor-form" onSubmit={(event) => { event.preventDefault(); void askTutor(tutorInput); }}><label htmlFor={`tutor-input-${question.id}`}>Ask a follow-up</label><div><textarea id={`tutor-input-${question.id}`} value={tutorInput} onChange={(event) => setTutorInput(event.target.value)} maxLength={1000} placeholder="What part should I revisit?" rows={2} /><button className="button" type="submit" disabled={!tutorInput.trim() || tutorLoading}>Send</button></div></form>
    </div>}
  </article>;
}

export default function PracticeClient({ questions, timeLimitMinutes }: { questions: Question[]; timeLimitMinutes: number | null }) {
  const [page, setPage] = useState(0);
  const [results, setResults] = useState<Record<number, boolean>>({});
  const [showResults, setShowResults] = useState(false);
  const [started, setStarted] = useState(false);
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState((timeLimitMinutes ?? 0) * 60);
  const [expired, setExpired] = useState(false);
  const pageSize = 5;
  const pages = Math.ceil(questions.length / pageSize);
  const visible = useMemo(() => questions.slice(page * pageSize, (page + 1) * pageSize), [page, questions]);
  const attempted = Object.keys(results).length;
  const earned = Object.values(results).filter(Boolean).length;
  const percentage = attempted ? Math.round((earned / attempted) * 100) : 0;
  function recordResult(questionId: number, correct: boolean) { setResults((current) => ({ ...current, [questionId]: correct })); }
  // The timer is deliberately opt-in so learners can study without exam pressure.
  useEffect(() => {
    if (!started || !timerEnabled || expired) return undefined;
    const interval = window.setInterval(() => setRemainingSeconds((current) => {
      if (current <= 1) { setExpired(true); return 0; }
      return current - 1;
    }), 1000);
    return () => window.clearInterval(interval);
  }, [expired, started, timerEnabled]);
  const minutes = Math.floor(remainingSeconds / 60).toString().padStart(2, "0");
  const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
  if (!questions.length) return <div className="empty-state">No questions have been imported yet. Run <code>npm run seed</code> to load the source PDFs.</div>;
  if (!started) return <div className="timer-setup"><p className="eyebrow">Set your pace</p><h2>How would you like to practice?</h2><p>The source paper recommends {timeLimitMinutes ?? 120} minutes. Choose a timed run to mimic the real exam, or study without a countdown.</p><div className="timer-choices"><label className={`timer-choice ${timerEnabled ? "selected" : ""}`}><input type="radio" name="timer-mode" checked={timerEnabled} onChange={() => setTimerEnabled(true)} /><span><strong>Timed exam</strong><small>{timeLimitMinutes ?? 120} minutes · countdown on</small></span></label><label className={`timer-choice ${!timerEnabled ? "selected" : ""}`}><input type="radio" name="timer-mode" checked={!timerEnabled} onChange={() => setTimerEnabled(false)} /><span><strong>Untimed study</strong><small>Reveal and learn at your own pace</small></span></label></div><button className="button" type="button" onClick={() => setStarted(true)}>Start practice →</button></div>;
  if (showResults) return <ExamResults questions={questions} results={results} onBack={() => setShowResults(false)} />;
  const canGetResult = attempted === questions.length || expired;
  return <><div className={`timer-bar ${expired ? "timer-expired" : remainingSeconds <= 300 ? "timer-warning" : ""}`} aria-live="polite"><span>{expired ? "Time expired · review mode" : "Exam timer"}</span>{!expired && <strong>{minutes}:{seconds}</strong>}<small>{timerEnabled ? `${timeLimitMinutes ?? 120} minute limit` : "Untimed study"}</small></div><div className="score-strip" aria-live="polite"><div><span className="score-label">Practice score</span><strong>{earned} / {questions.length}</strong><span className="score-subtext">marks earned</span></div><div><span className="score-label">Attempted</span><strong>{attempted}</strong><span className="score-subtext">of {questions.length} questions</span></div><div><span className="score-label">Accuracy</span><strong>{percentage}%</strong><span className="score-subtext">on revealed answers</span></div></div><div aria-live="polite" className="question-help" style={{ marginBottom: 16 }}>Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, questions.length)} of {questions.length} · 1 mark per question</div>{visible.map((question, index) => <QuestionCard question={question} index={page * pageSize + index} onResult={recordResult} key={question.sourceKey} />)}<nav className="pagination" aria-label="Question pages"><button className="button secondary" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>← Previous</button>{page === pages - 1 ? <button className="button" disabled={!canGetResult} onClick={() => setShowResults(true)}>{canGetResult ? "Get result →" : `Reveal all answers (${attempted}/${questions.length})`}</button> : <><span className="card-meta">Page {page + 1} of {pages}</span><button className="button" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>Next page →</button></>}</nav></>;
}
