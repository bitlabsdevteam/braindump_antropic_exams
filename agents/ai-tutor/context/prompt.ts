import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let cached: { text: string; hash: string } | undefined;

export function getTutorPrompt() {
  if (!cached) {
    const file = path.join(process.cwd(), "prompts", "personal-ai-tutor.system.md");
    const text = fs.readFileSync(file, "utf8");
    cached = { text, hash: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) };
  }
  return cached;
}
