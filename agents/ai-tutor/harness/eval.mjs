import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const evalPath = path.join(root, "prompts", "personal-ai-tutor.evals.md");
const runtimePath = path.join(root, "agents", "ai-tutor", "runtime.ts");
const toolsPath = path.join(root, "agents", "ai-tutor", "tools", "index.ts");
const prompt = fs.readFileSync(evalPath, "utf8");
const runtime = fs.readFileSync(runtimePath, "utf8");
const tools = fs.readFileSync(toolsPath, "utf8");
const cases = [...prompt.matchAll(/^\|\s+(\d+)\s+\|/gm)].map((match) => Number(match[1]));
const required = [
  "get_question_context",
  "find_related_questions",
  "get_revealed_answer",
  "get_session_learning_context",
];
const failures = [];
if (cases.length !== 28 || cases.some((value, index) => value !== index + 1))
  failures.push("The evaluation suite must contain cases 1 through 28 exactly once.");
for (const tool of required)
  if (!runtime.includes(tool) || !tools.includes(tool))
    failures.push(`Missing tool coverage: ${tool}`);
for (const token of ["maxCalls", "maxTools", "deadlineMs", "ToolPermissionError", "seen.has"])
  if (!runtime.includes(token)) failures.push(`Missing harness control: ${token}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Tutor harness contract passed: ${cases.length} documented evaluation cases and ${required.length} tools are wired into the runtime.`,
);
