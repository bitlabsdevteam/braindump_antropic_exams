import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("PDF import preserves identities and source content, and flags the inconsistent source answer", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coach-seed-"));
  const dbPath = path.join(directory, "exams.db");
  const env = { ...process.env, EXAMS_DB_PATH: dbPath };
  try {
    const first = execFileSync(process.execPath, ["scripts/seed.mjs"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(first, /inserted: 236; updated: 0/);
    const db = new Database(dbPath);
    try {
      const identities = () =>
        Object.fromEntries(
          ["certifications", "domains", "scenarios", "questions", "options", "match_items"].map(
            (table) => [
              table,
              db
                .prepare<unknown[], Record<string, string | number | null>>(
                  `SELECT id FROM ${table} ORDER BY id`,
                )
                .all(),
            ],
          ),
        );
      const original = identities();
      // Reproduce the previous parser's footer-generated extra matching option.
      db.prepare(
        "INSERT INTO options(question_id, option_key, text, ordinal) SELECT id, 'Z', 'CCAR-P Practice Questions footer', 26 FROM questions WHERE source_key = 'professional-1.11'",
      ).run();
      const second = execFileSync(process.execPath, ["scripts/seed.mjs"], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(second, /inserted: 0; updated: 236/);
      assert.deepEqual(identities(), original);
      assert.deepEqual(
        db
          .prepare<unknown[], Record<string, string | number | null>>(
            "SELECT question_count FROM certifications ORDER BY id",
          )
          .all(),
        [
          { question_count: 63 },
          { question_count: 60 },
          { question_count: 53 },
          { question_count: 60 },
        ],
      );
      assert.equal(
        db
          .prepare<unknown[], Record<string, string | number | null>>(
            "SELECT count(*) AS n FROM questions WHERE source_page IS NULL",
          )
          .get()?.n,
        0,
      );
      assert.equal(
        db
          .prepare<unknown[], Record<string, string | number | null>>(
            "SELECT count(*) AS n FROM certifications WHERE time_limit_minutes = 120 AND disclaimer LIKE 'Important: these are original practice questions%' AND source_version LIKE '%Exam Guide v1.0%'",
          )
          .get()?.n,
        4,
      );
      assert.equal(
        db
          .prepare<unknown[], Record<string, string | number | null>>(
            "SELECT count(*) AS n FROM scenarios WHERE length(description) > 0",
          )
          .get()?.n,
        6,
      );
      const disputed = db
        .prepare<unknown[], Record<string, string | number | null>>(
          "SELECT q.source_key, q.review_note, a.correct_keys FROM questions q JOIN answers a ON a.question_id = q.id WHERE q.review_required = 1",
        )
        .all();
      assert.equal(disputed.length, 1);
      assert.equal(disputed[0].source_key, "developer-5.9");
      assert.equal(disputed[0].correct_keys, '["A","D"]');
      assert.match(String(disputed[0].review_note), /excluded from scoring/);
      const wrapped = db
        .prepare<unknown[], Record<string, string | number | null>>(
          "SELECT text FROM match_items WHERE question_id = (SELECT id FROM questions WHERE source_key = 'professional-1.11') AND item_key = '1'",
        )
        .get();
      assert.equal(
        wrapped?.text,
        "Summarising each inbound support email into a CRM note, with retrieval of the customer’s account record for context. → ______",
      );
      for (const table of ["options", "match_items"]) {
        assert.equal(
          db
            .prepare<unknown[], Record<string, string | number | null>>(
              `SELECT count(*) AS n FROM ${table} WHERE text LIKE '%Practice Questions%' OR text LIKE '%Domain 2:%' OR text LIKE '%Answer Key & Rationales%'`,
            )
            .get()?.n,
          0,
        );
      }
      for (const question of db
        .prepare<unknown[], Record<string, string | number | null>>(
          "SELECT q.id, q.type, q.selection_count, a.correct_keys FROM questions q JOIN answers a ON a.question_id = q.id WHERE q.review_required = 0",
        )
        .all()) {
        const keys = JSON.parse(String(question.correct_keys)) as string[];
        assert.equal(keys.length, question.selection_count);
        const optionKeys = db
          .prepare<unknown[], Record<string, string | number | null>>(
            "SELECT option_key FROM options WHERE question_id = ?",
          )
          .all(question.id)
          .map((row) => row.option_key);
        for (const key of keys)
          assert.ok(
            optionKeys.includes(question.type === "scenario_matching" ? key.split(":")[1] : key),
          );
      }
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const strict = spawnSync(process.execPath, ["scripts/seed.mjs", "--strict"], {
        env,
        encoding: "utf8",
      });
      assert.notEqual(strict.status, 0);
      assert.match(strict.stderr, /source discrepancy requires review/);
      assert.deepEqual(identities(), original);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
