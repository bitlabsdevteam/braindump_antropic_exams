import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTutorPromptLoader, getTutorPrompt } from "../agents/ai-tutor/context/prompt";
import { TutorServiceError, tutorFailure } from "../lib/tutor-errors";

test("composed instructions retain the exact operational policy and Chiikawa personality", () => {
  const prompt = getTutorPrompt();
  for (const file of ["prompts/personal-ai-tutor.system.md", "SOUL.MD"])
    assert.ok(prompt.text.includes(fs.readFileSync(file, "utf8")));
  assert.match(prompt.text, /You are Chiikawa/);
  assert.match(
    prompt.text,
    /operational policy and server-enforced runtime permissions take precedence/,
  );
  assert.match(prompt.hash, /^[a-f0-9]{16}$/);
  assert.strictEqual(getTutorPrompt(), prompt);
});

test("either file changes the full instruction hash after a new process load", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chiikawa-prompt-"));
  try {
    fs.mkdirSync(path.join(root, "prompts"));
    const policy = path.join(root, "prompts/personal-ai-tutor.system.md");
    const soul = path.join(root, "SOUL.MD");
    fs.writeFileSync(policy, "Operational rules");
    fs.writeFileSync(soul, "Chiikawa personality");
    const load = createTutorPromptLoader(root);
    const first = load();
    fs.writeFileSync(soul, "Chiikawa personality edited");
    assert.strictEqual(load(), first, "successful loads remain cached until restart");
    const second = createTutorPromptLoader(root)();
    assert.notEqual(first.hash, second.hash);
    fs.appendFileSync(policy, "\nExtra rule");
    const third = createTutorPromptLoader(root)();
    assert.notEqual(second.hash, third.hash);
    assert.equal(third.hash, createTutorPromptLoader(root)().hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing or empty files produce a sanitized configuration failure and failed loads can recover", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chiikawa-missing-"));
  try {
    fs.mkdirSync(path.join(root, "prompts"));
    const policy = path.join(root, "prompts/personal-ai-tutor.system.md");
    const soul = path.join(root, "SOUL.MD");
    fs.writeFileSync(policy, "Operational rules");
    const load = createTutorPromptLoader(root);
    function fails() {
      assert.throws(load, (error: unknown) => {
        assert.ok(error instanceof TutorServiceError);
        assert.equal(tutorFailure(error).code, "configuration");
        assert.match(error.message, /Practice and source answers are still available/);
        assert.ok(!error.message.includes(root));
        return true;
      });
    }
    fails();
    fs.writeFileSync(soul, " \n\t");
    fails();
    fs.writeFileSync(soul, "Chiikawa");
    fs.writeFileSync(policy, "");
    fails();
    fs.writeFileSync(policy, "Operational rules");
    assert.match(load().text, /Chiikawa/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
