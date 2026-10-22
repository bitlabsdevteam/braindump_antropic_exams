import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "aids-seed-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function seedWith(aids: unknown) {
  const dir = path.join(directory, `aids-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "aids.json"), JSON.stringify({ version: 1, questions: aids }));
  return () =>
    execFileSync(process.execPath, ["scripts/seed.mjs"], {
      env: { ...process.env, EXAMS_DB_PATH: path.join(directory, "exams.db"), AIDS_DIR: dir },
      stdio: "pipe",
    });
}
const good = {
  status: "draft",
  concept: "A concept",
  hints: ["One nudge"],
  optionNotes: { A: "Note" },
};

test("seeding fails loudly on aids that do not match the source bank", () => {
  assert.throws(seedWith({ "associate-99.99": good }), /does not match any question/);
  assert.throws(
    seedWith({ "associate-1.1": { ...good, optionNotes: { Z: "No such option" } } }),
    /unknown option Z/,
  );
  assert.throws(seedWith({ "associate-1.1": { ...good, hints: [] } }), /1-3 non-empty hints/);
  assert.throws(seedWith({ "associate-1.1": { ...good, status: "final" } }), /invalid status/);
  assert.throws(seedWith({ "developer-5.9": good }), /flagged for source review/);
});

test("valid aids load, and rerunning replaces rather than duplicates them", () => {
  const run = seedWith({ "associate-1.1": good });
  assert.match(run().toString(), /study aids: 1/);
  assert.match(run().toString(), /study aids: 1/);
});
