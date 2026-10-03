import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getQuestions } from "../../../lib/db";
import { getState } from "../../../lib/practice";
import { foundryConfiguration } from "../../../lib/foundry";
import { ensureSession, beginRun, finishRun, sessionDatabase } from "../context/session";
import { getTutorPrompt } from "../context/prompt";
import { createContext } from "../tools";
import { runTutorAgent } from "../runtime";
import { appendTurn, checkpoint, preferences } from "../memory/store";
import { compactionPromptHash } from "../memory/compaction";
import { tutorFailure } from "../../../lib/tutor-errors";

async function main() {
  const configuration = foundryConfiguration();
  process.env.TUTOR_TRACE = "1";
  const folder = path.resolve("output/chiikawa-memory", `${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(folder, { recursive: true });
  // This harness never writes to a learner's actual database.
  process.env.LEARNING_DB_PATH = path.join(folder, "learning.db");
  const id = ensureSession();
  const questions = getQuestions("architect-professional");
  const first = questions[0];
  const report: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    deployment: configuration.model,
    promptHash: getTutorPrompt().hash,
    compactionPromptHash,
    fixture:
      "Synthetic learning dialogue in an isolated SQLite database; real active question context",
    humanReview: "pending",
    runs: [],
  };
  const results: {
    message: string;
    reply: Awaited<ReturnType<typeof runTutorAgent>>;
    activities: unknown[];
    streamedUpdates: number;
  }[] = [];
  async function ask(questionId: number, message: string) {
    const state = getState(id, questionId);
    const context = createContext(questionId, {
      selectedKeys: [],
      answerRevealed: false,
      reasoning: "",
      hintStage: 1,
      intent: "follow_up",
      revision: state.revision,
    });
    const requestId = crypto.randomUUID();
    if (!beginRun(id, requestId)) throw new Error("Run acquisition failed");
    const activities: unknown[] = [];
    let deltas = 0;
    try {
      const reply = await runTutorAgent(
        { sessionId: id, questionId, requestId, message, learnerState: context.state },
        context,
        {
          onEvent: (event) => {
            if (event.type === "activity") activities.push(event);
            if (event.type === "delta") deltas++;
          },
        },
      );
      const result = { message, reply, activities, streamedUpdates: deltas };
      results.push(result);
      return result;
    } finally {
      finishRun(id, requestId);
      report.runs = results;
      fs.writeFileSync(path.join(folder, "report.json"), JSON.stringify(report, null, 2));
    }
  }
  try {
    await ask(
      first.id,
      "For future study, please remember that I prefer brief explanations with examples, and that I am a beginner.",
    );
    const saved = preferences(id);
    if (
      !saved.some((item) => item.key === "depth" && item.value === "brief") ||
      !saved.some((item) => item.key === "experience" && item.value === "beginner")
    )
      throw new Error("Explicit preference recall failed");
    // Exercise a real checkpoint without charging for filler model conversations.
    for (let i = 0; i < 12; i++)
      appendTurn({
        sessionId: id,
        sourceKey: first.sourceKey,
        requestId: `synthetic-${i}`,
        revealed: false,
        user:
          i === 0
            ? "I keep mixing up the size of a model's input context with its output limit. Please help me separate those concepts."
            : `Synthetic follow-up ${i}: continue explaining the difference between input context size and output limit, using neutral examples.`,
        reply: {
          approach: "Separate input and output limits.",
          message:
            "Input context is what a model can consider; an output limit bounds what it generates. Both matter when planning a request. A summary can preserve a conversation's main points while keeping recent turns intact.",
          concept: "Input context and output limits differ.",
          nextStep: "Explain the distinction in your own words.",
        },
        tools: [],
        promptHash: "synthetic-fixture",
        updates: [],
      });
    await ask(
      first.id,
      "What distinction was I struggling with earlier? Use my preferred teaching style, and keep the source answer hidden.",
    );
    const summary = checkpoint(id, first.sourceKey, false);
    if (!summary) throw new Error("Live compaction did not produce a checkpoint");
    report.checkpoint = summary;
    report.preferences = saved;
    await ask(
      questions[1].id,
      "How would you adapt your explanation to my saved preferences and experience? Do not identify any answer.",
    );
    report.outcome = "completed";
    console.log(
      "Live memory checks completed: preference persistence, actual compaction, same-question recall, and cross-question preferences. Review report for teaching quality.",
    );
  } catch (error) {
    report.outcome = "failed";
    report.traces = results.map((result) =>
      JSON.parse(
        fs.readFileSync(path.join("data/tutor-traces", `${result.reply.runId}.json`), "utf8"),
      ),
    );
    report.failure = tutorFailure(error).code;
    process.exitCode = 1;
    console.error("Live memory check failed; inspect sanitized report and configuration.");
  } finally {
    fs.writeFileSync(path.join(folder, "report.json"), JSON.stringify(report, null, 2));
    sessionDatabase().close();
    console.log(`Memory evaluation artifact: ${path.join(folder, "report.json")}`);
  }
}
main().catch((error) => {
  console.error(tutorFailure(error).message);
  process.exitCode = 1;
});
