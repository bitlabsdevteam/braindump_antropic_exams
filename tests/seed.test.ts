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
    assert.match(first, /inserted: 472; updated: 0/);
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
      assert.match(second, /inserted: 0; updated: 472/);
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
          { question_count: 60 },
          { question_count: 63 },
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
        12,
      );
      const revisions = db
        .prepare(
          "SELECT slug, source_file, source_revised_at, time_limit_minutes, source_version, source_license, source_author FROM certifications WHERE source_revised_at IS NOT NULL ORDER BY source_revised_at",
        )
        .all() as Record<string, string | number | null>[];
      assert.deepEqual(
        revisions.map((row) => [row.slug, row.source_file, row.source_revised_at]),
        [
          ["architect-professional-v2", "pdf/1793435805966.pdf", "2026-11-03"],
          ["developer-foundations-v2", "pdf/1793437533661.pdf", "2026-11-04"],
          ["associate-foundations-v2", "pdf/1793438128494.pdf", "2026-11-05"],
        ],
      );
      for (const revision of revisions) {
        assert.equal(revision.time_limit_minutes, null);
        assert.match(String(revision.source_version), /^Revised [345] November 2026/);
        assert.match(String(revision.source_license), /CC BY-NC 4\.0/);
        assert.equal(revision.source_author, "Matthew Purcell");
      }
      const revisedFormats = db
        .prepare(
          "SELECT c.slug, q.type, count(*) AS n FROM questions q JOIN certifications c ON c.id = q.certification_id WHERE c.source_revised_at IS NOT NULL GROUP BY c.slug, q.type ORDER BY c.slug, q.type",
        )
        .all();
      assert.deepEqual(revisedFormats, [
        { slug: "architect-professional-v2", type: "multiple_response", n: 13 },
        { slug: "architect-professional-v2", type: "scenario_matching", n: 20 },
        { slug: "architect-professional-v2", type: "single_choice", n: 30 },
        { slug: "associate-foundations-v2", type: "multiple_response", n: 19 },
        { slug: "associate-foundations-v2", type: "single_choice", n: 41 },
        { slug: "developer-foundations-v2", type: "multiple_response", n: 7 },
        { slug: "developer-foundations-v2", type: "scenario_matching", n: 4 },
        { slug: "developer-foundations-v2", type: "single_choice", n: 42 },
      ]);
      const revisedQuestion = (key: string) =>
        db
          .prepare(
            "SELECT q.id, q.prompt, q.source_format, q.source_page, a.correct_keys, a.rationale FROM questions q JOIN answers a ON a.question_id = q.id WHERE q.source_key = ?",
          )
          .get(key) as Record<string, string | number>;
      const yesNo = revisedQuestion("developer-v2-1.8");
      assert.equal(yesNo.source_format, "Matching · Yes/No");
      assert.equal(yesNo.correct_keys, '["1:B","2:A","3:A","4:A","5:B","6:B"]');
      assert.deepEqual(
        db
          .prepare("SELECT text FROM match_items WHERE question_id = ? ORDER BY ordinal")
          .all(yesNo.id),
        [
          {
            text: "Context-window management is unnecessary in an agent loop because the API discards old turns automatically.",
          },
          {
            text: "A tool-use loop ends when the model returns a response that contains no further tool calls.",
          },
          {
            text: "An agentic framework such as LangGraph or Strands can orchestrate a Claude agent while the Claude API remains the model interface.",
          },
          {
            text: "Memory across sessions must be implemented by the application; the model retains no state between API calls.",
          },
          {
            text: "Adopting an agentic framework commits the team to that framework's default model provider.",
          },
          {
            text: "Subagents share the parent agent's context window, so delegating a task does not reduce the parent's context usage.",
          },
        ],
      );
      const classify = revisedQuestion("professional-v2-3.10");
      assert.equal(classify.correct_keys, '["1:B","2:A","3:C","4:A","5:C","6:B"]');
      assert.deepEqual(
        db
          .prepare("SELECT text FROM options WHERE question_id = ? ORDER BY ordinal")
          .all(classify.id),
        [
          { text: "Long Structured Documents" },
          { text: "Heterogeneous Short Records" },
          { text: "Code or Hierarchical Specs" },
        ],
      );
      const ordering = revisedQuestion("associate-v2-1.8");
      assert.equal(ordering.source_format, "Ordering");
      assert.equal(ordering.correct_keys, '["C"]');
      assert.match(
        String(ordering.prompt),
        /\n\(5\) Gather and attach the source material on each programme\.$/,
      );
      assert.match(String(ordering.rationale), /^Correct sequence: 2, 5, 1, 4, 3\./);
      assert.equal(
        (
          db
            .prepare("SELECT count(*) AS n FROM questions WHERE source_format = 'Ordering'")
            .get() as { n: number }
        ).n,
        10,
      );
      assert.equal(revisedQuestion("developer-v2-5.9").correct_keys, '["A"]');
      const haider = db
        .prepare("SELECT * FROM certifications WHERE slug = 'architect-foundations-haider'")
        .get() as Record<string, string | number | null>;
      assert.equal(haider.title, "Claude Certified Architect – Foundations");
      assert.equal(haider.source_file, "pdf/1793260252763.pdf");
      assert.equal(haider.source_version, "Muhammad Haider Yar · October 2026");
      assert.equal(haider.time_limit_minutes, null);
      assert.match(
        String(haider.disclaimer),
        /^Please note\. These are original practice questions/,
      );
      assert.match(String(haider.disclaimer), /not affiliated with or endorsed by Anthropic\.$/);
      const newQuestions = db
        .prepare(
          "SELECT q.source_key, q.ordinal, q.type, q.selection_count, q.prompt, q.source_page, d.number AS domain_number, s.number AS scenario_number, a.correct_keys, a.rationale FROM questions q JOIN domains d ON d.id = q.domain_id JOIN scenarios s ON s.id = q.scenario_id JOIN answers a ON a.question_id = q.id WHERE q.certification_id = ? ORDER BY q.ordinal",
        )
        .all(haider.id) as Record<string, string | number>[];
      assert.equal(newQuestions.length, 60);
      assert.deepEqual(
        newQuestions.map((question) => question.source_key),
        Array.from(
          { length: 60 },
          (_, index) => `foundations-haider-${Math.floor(index / 10) + 1}.${(index % 10) + 1}`,
        ),
      );
      assert.deepEqual(
        newQuestions.map((question) => question.ordinal),
        Array.from({ length: 60 }, (_, index) => index + 1),
      );
      assert.deepEqual(
        [1, 2, 3, 4, 5].map(
          (number) => newQuestions.filter((question) => question.domain_number === number).length,
        ),
        [16, 11, 12, 12, 9],
      );
      for (const [index, question] of newQuestions.entries()) {
        assert.equal(question.scenario_number, Math.floor(index / 10) + 1);
        assert.match(String(question.rationale), /^Exam guide task statement [\d., ]+ Domain \d /);
        assert.doesNotMatch(
          `${question.prompt} ${question.rationale}`,
          /SCENARIO|Practice Questions|How did you do\?/,
        );
      }
      assert.equal(newQuestions.filter((question) => question.type === "single_choice").length, 49);
      assert.equal(
        newQuestions.filter((question) => question.type === "multiple_response").length,
        11,
      );
      assert.equal(newQuestions[0].source_page, 3);
      assert.equal(newQuestions[0].correct_keys, '["C"]');
      assert.equal(
        newQuestions[0].prompt,
        "Audit logs show that 7% of refunds last month were issued against a customer ID that appeared in the user's own message but was not returned by get_customer. The agent's system prompt already says to verify identity first. Which change most reliably prevents this class of incident?",
      );
      assert.equal(newQuestions[4].selection_count, 2);
      assert.equal(newQuestions[4].correct_keys, '["A","C"]');
      assert.equal(newQuestions[59].source_page, 25);
      assert.equal(newQuestions[59].correct_keys, '["D"]');
      assert.match(
        String(newQuestions[59].rationale),
        /does not change how the model processes the middle of long inputs\.$/,
      );
      assert.equal(
        db
          .prepare<unknown[], { n: number }>(
            "SELECT count(*) AS n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.certification_id = ?",
          )
          .get(haider.id)?.n,
        251,
      );
      assert.equal(
        db
          .prepare<unknown[], { n: number }>(
            "SELECT count(*) AS n FROM options o JOIN questions q ON q.id = o.question_id WHERE q.certification_id = ? AND (o.text GLOB '*SCENARIO [1-6]*' OR o.text LIKE '%Answer key%')",
          )
          .get(haider.id)?.n,
        0,
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
