import fs from "node:fs";
import path from "node:path";

const directory = path.join(process.cwd(), "data", "tutor-traces");
if (!fs.existsSync(directory)) {
  console.log(
    "No local tutor traces. Set TUTOR_TRACE=1 while running the app to capture redacted trace metadata.",
  );
  process.exit(0);
}
const files = fs
  .readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .sort();
for (const file of files) {
  const trace = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  console.log(
    `${trace.runId} ${trace.outcome ?? "running"} ${trace.startedAt} events=${Array.isArray(trace.events) ? trace.events.length : 0} prompt=${trace.promptHash}`,
  );
}
