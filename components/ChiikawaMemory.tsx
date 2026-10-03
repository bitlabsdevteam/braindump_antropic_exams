"use client";

import { useEffect, useRef, useState } from "react";
import type { MemoryView, PreferenceKey } from "../lib/tutor-memory-types";

export default function ChiikawaMemory({
  questionId,
  disabled,
  version,
  onForget,
}: {
  questionId: number;
  disabled: boolean;
  version: string;
  onForget: (key?: PreferenceKey) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MemoryView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    controller.current?.abort();
    setData(null);
    if (open) void load();
    // Refresh saved history on completed/cancelled responses; opening has its own load.
  }, [version]);
  const [viewingOlder, setViewingOlder] = useState(false);
  async function load(before?: number) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/tutor/memory?questionId=${questionId}${before ? `&before=${before}` : ""}`,
        { cache: "no-store", signal: request.signal },
      );
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || "Memory could not be loaded.");
      if (!request.signal.aborted) {
        setData(next);
        setViewingOlder(Boolean(before));
      }
    } catch (cause) {
      if (!request.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }
  async function forget(key?: PreferenceKey) {
    controller.current?.abort();
    setLoading(true);
    setError("");
    try {
      await onForget(key);
      setConfirm(false);
      setData(null);
      await load();
    } catch (cause) {
      setError((cause as Error).message);
      setLoading(false);
    }
  }
  return (
    <section className="chiikawa-memory" aria-label="Study memory">
      <button
        className="text-button"
        aria-expanded={open}
        aria-controls="chiikawa-memory-details"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
          else controller.current?.abort();
        }}
      >
        Memory &amp; conversation history
      </button>
      {open && (
        <div id="chiikawa-memory-details">
          <p className="tutor-note">
            Chiikawa remembers completed conversations and your stated teaching preferences for this
            browser’s 30-day learning session. Summaries may miss details. Revealed-answer
            conversations stay out of hidden-answer coaching.
          </p>
          {loading && <p role="status">Loading study memory…</p>}
          {error && (
            <p role="alert">
              {error}{" "}
              <button className="text-button" onClick={() => void load()}>
                Retry
              </button>
            </p>
          )}
          {data && (
            <>
              <h3>Teaching preferences</h3>
              {data.preferences.length ? (
                <ul>
                  {data.preferences.map((item) => (
                    <li key={item.key}>
                      <span>
                        {item.key}: {item.value.replace(/_/g, " ")}
                      </span>{" "}
                      <button
                        className="text-button"
                        disabled={disabled || loading}
                        onClick={() => void forget(item.key)}
                        aria-label={`Forget ${item.key} preference`}
                      >
                        Forget
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No preferences saved yet. Tell Chiikawa how you like to learn.</p>
              )}
              {data.summary && (
                <>
                  <h3>Earlier conversation summary</h3>
                  <p>{data.summary.goal}</p>
                  <ul>
                    {data.summary.learningNotes.map((note, i) => (
                      <li key={i}>{note.text}</li>
                    ))}
                  </ul>
                  <ul>
                    {data.summary.openQuestions.map((question, i) => (
                      <li key={i}>{question}</li>
                    ))}
                  </ul>
                  <p>{data.summary.nextStep}</p>
                </>
              )}
              <h3>This question’s conversation</h3>
              <p className="tutor-note">
                {data.scope === "revealed"
                  ? "Conversations after reveal"
                  : "Conversations while the answer was hidden"}
              </p>
              {data.turns.length ? (
                data.turns.map((turn) => (
                  <article className="memory-turn" key={turn.id}>
                    <p>
                      <strong>You</strong>
                      <br />
                      {turn.user}
                    </p>
                    <p>
                      <strong>Chiikawa</strong>
                      <br />
                      {turn.assistant.message}
                    </p>
                    <p>{turn.assistant.concept}</p>
                    <p>{turn.assistant.nextStep}</p>
                  </article>
                ))
              ) : (
                <p>No completed conversations in this phase yet.</p>
              )}
              {data.hasMore && (
                <button
                  className="text-button"
                  disabled={loading}
                  onClick={() => void load(data.nextBefore!)}
                >
                  Older conversations
                </button>
              )}
              {viewingOlder && (
                <button className="text-button" disabled={loading} onClick={() => void load()}>
                  Latest conversations
                </button>
              )}
              <p className="tutor-note">Expires {new Date(data.expiresAt).toLocaleDateString()}.</p>
            </>
          )}
          {!confirm ? (
            <button
              className="text-button"
              disabled={disabled || loading}
              onClick={() => setConfirm(true)}
            >
              Forget all study memory
            </button>
          ) : (
            <div role="group" aria-label="Confirm memory deletion">
              <p>
                Forget all Chiikawa conversations, summaries, and preferences in this browser? Your
                grades will be kept.
              </p>
              <button
                className="button secondary"
                disabled={disabled || loading}
                onClick={() => void forget()}
              >
                Forget memory
              </button>{" "}
              <button className="text-button" onClick={() => setConfirm(false)}>
                Keep memory
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
