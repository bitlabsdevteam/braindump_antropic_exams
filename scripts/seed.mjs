import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const root = process.cwd();
const pdfDir = path.join(root, "pdf");
const dataDir = path.join(root, "data");
const dbPath = process.env.EXAMS_DB_PATH || path.join(dataDir, "exams.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS certifications (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, short_title TEXT NOT NULL, description TEXT NOT NULL, question_count INTEGER NOT NULL, domain_count INTEGER NOT NULL, time_limit_minutes INTEGER, source_file TEXT NOT NULL, disclaimer TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS domains (id INTEGER PRIMARY KEY AUTOINCREMENT, certification_id INTEGER NOT NULL REFERENCES certifications(id) ON DELETE CASCADE, number INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(certification_id, number));
CREATE TABLE IF NOT EXISTS scenarios (id INTEGER PRIMARY KEY AUTOINCREMENT, certification_id INTEGER NOT NULL REFERENCES certifications(id) ON DELETE CASCADE, number INTEGER NOT NULL, title TEXT NOT NULL, UNIQUE(certification_id, number));
CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, certification_id INTEGER NOT NULL REFERENCES certifications(id) ON DELETE CASCADE, domain_id INTEGER REFERENCES domains(id), scenario_id INTEGER REFERENCES scenarios(id), source_key TEXT NOT NULL UNIQUE, ordinal INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('single_choice', 'multiple_response', 'scenario_matching')), prompt TEXT NOT NULL, selection_count INTEGER NOT NULL, source_page INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE, option_key TEXT NOT NULL, text TEXT NOT NULL, ordinal INTEGER NOT NULL, UNIQUE(question_id, option_key));
CREATE TABLE IF NOT EXISTS match_items (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE, item_key TEXT NOT NULL, text TEXT NOT NULL, ordinal INTEGER NOT NULL, UNIQUE(question_id, item_key));
CREATE TABLE IF NOT EXISTS answers (question_id INTEGER PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE, correct_keys TEXT NOT NULL, rationale TEXT NOT NULL);
`;

const definitions = {
  professional: {
    file: "1783837911603.pdf",
    slug: "architect-professional",
    title: "Claude Certified Architect – Professional",
    shortTitle: "Architect – Professional",
    description:
      "A full-length set covering solution design, context engineering, integration, evaluation, governance, stakeholder communication, and developer enablement.",
  },
  foundations: {
    file: "1786162352230.pdf",
    slug: "architect-foundations",
    title: "Claude Certified Architect – Foundations",
    shortTitle: "Architect – Foundations",
    description:
      "A scenario-based set covering agentic architecture, MCP integration, Claude Code workflows, structured output, and reliable context management.",
  },
  developer: {
    file: "1784425506971.pdf",
    slug: "developer-foundations",
    title: "Claude Certified Developer – Foundations",
    shortTitle: "Developer – Foundations",
    description:
      "A full-length set covering agents and workflows, applications and integration, Claude Code, evaluation, model optimization, prompting, safety, and MCP tools.",
  },
  associate: {
    file: "1784425984382.pdf",
    slug: "associate-foundations",
    title: "Claude Certified Associate – Foundations",
    shortTitle: "Associate – Foundations",
    description:
      "A full-length set covering prompting, output validation, product and model selection, workflow integration, configuration, governance, and troubleshooting.",
  },
};

// PDF layout artifacts are removed, but wording and punctuation remain source text.
function cleanLine(line) {
  return line.replace(/[\u200b\u200c\u200d\ufeff]/g, "").trim();
}
function cleanText(lines) {
  return lines.map(cleanLine).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
function fail(message) {
  throw new Error(`Question bank validation: ${message}`);
}
const expectedCounts = { professional: 63, foundations: 60, developer: 53, associate: 60 };

function parsePdf(def, kind) {
  const raw = execFileSync("pdftotext", ["-layout", path.join(pdfDir, def.file), "-"], {
    encoding: "utf8",
  });
  const pages = raw.replace(/\r/g, "").split("\f");
  const lines = pages.flatMap((page, index) =>
    page
      .split("\n")
      .map(cleanLine)
      .filter((line) => line && !/^CC(?:AR|AO|DV)-[PF] Practice Questions/.test(line))
      .map((text) => ({ text, page: index + 1 })),
  );
  const texts = lines.map((line) => line.text);
  const firstQuestion = texts.findIndex((line) => /^Question \d+\.\d+ ·/.test(line));
  const preface = cleanText(texts.slice(0, firstQuestion));
  if (texts[0] !== def.title) fail(`${def.file}: unexpected source title ${texts[0]}`);
  if (!preface.includes("Exam Guide v1.0 (July 2026)"))
    fail(`${kind}: unreviewed exam guide version`);
  if (kind === "foundations" && !preface.includes("Version 2 ·"))
    fail(`${kind}: unreviewed source version`);
  const time = preface.match(/give yourself (\d+) minutes/);
  if (!time || Number(time[1]) !== 120) fail(`${kind}: missing or changed time limit`);
  const disclaimer = preface.match(/Important:.*?(?= How the \d+ questions are distributed)/)?.[0];
  if (!disclaimer) fail(`${kind}: missing source disclaimer`);
  const blueprint = [...preface.matchAll(/(\d+)\.\s+(.+?) — ([\d.]+)% → (\d+) questions?/g)].map(
    (match) => ({
      number: Number(match[1]),
      name: match[2],
      weight: Number(match[3]),
      count: Number(match[4]),
    }),
  );
  if (
    !blueprint.length ||
    blueprint.reduce((sum, item) => sum + item.count, 0) !== expectedCounts[kind]
  )
    fail(`${kind}: invalid blueprint`);
  const answerStart = texts.indexOf("Answer Key & Rationales");
  if (answerStart < firstQuestion) fail(`${kind}: missing answer section`);
  const questionLines = texts.slice(0, answerStart);
  const markers = questionLines.flatMap((line, index) => {
    const match = line.match(/^Question (\d+)\.(\d+) · (.+)$/);
    return match
      ? [
          {
            index,
            group: Number(match[1]),
            number: Number(match[2]),
            header: match[3],
            key: `${match[1]}.${match[2]}`,
          },
        ]
      : [];
  });
  const answerLines = texts.slice(answerStart + 1);
  const answerMarkers = answerLines.flatMap((line, index) => {
    const match = line.match(/^(\d+\.\d+) — (.+)$/);
    return match ? [{ index, key: match[1], header: match[2] }] : [];
  });
  const answers = new Map();
  for (const [index, marker] of answerMarkers.entries()) {
    if (answers.has(marker.key)) fail(`${kind}: duplicate answer ${marker.key}`);
    const body = answerLines.slice(
      marker.index + 1,
      answerMarkers[index + 1]?.index ?? answerLines.length,
    );
    // Section headings and the author's closing invitation are not part of a rationale.
    const end = body.findIndex((line) =>
      /^(?:Domain \d+:|Scenario \d+:|How did you go\?)/.test(line),
    );
    answers.set(marker.key, { header: marker.header, body: end < 0 ? body : body.slice(0, end) });
  }
  const scenarios = new Map();
  const questions = [];
  const seen = new Set();
  const groupCounts = new Map();
  for (const [index, marker] of markers.entries()) {
    if (seen.has(marker.key)) fail(`${kind}: duplicate question ${marker.key}`);
    seen.add(marker.key);
    const previous = groupCounts.get(marker.group) ?? 0;
    if (marker.number !== previous + 1)
      fail(`${kind}: missing or out-of-order question before ${marker.key}`);
    groupCounts.set(marker.group, marker.number);
    let block = questionLines.slice(
      marker.index + 1,
      markers[index + 1]?.index ?? questionLines.length,
    );
    const sectionEnd = block.findIndex((line) => /^(?:Domain \d+:|Scenario \d+:)/.test(line));
    if (sectionEnd >= 0) block = block.slice(0, sectionEnd);
    const headerDomain = marker.header.match(/Domain (\d+)/);
    const domainNumber = headerDomain ? Number(headerDomain[1]) : marker.group;
    const domain = blueprint.find((entry) => entry.number === domainNumber);
    if (!domain) fail(`${kind} ${marker.key}: unknown domain`);
    let scenario = null;
    if (kind === "foundations") {
      const scenarioIndex = questionLines
        .slice(0, marker.index)
        .findLastIndex((line) => line.startsWith(`Scenario ${marker.group}:`));
      if (scenarioIndex < 0) fail(`${kind} ${marker.key}: missing scenario`);
      const title = questionLines[scenarioIndex].replace(/^Scenario \d+:\s*/, "");
      const firstScenarioQuestion = markers.find((item) => item.group === marker.group).index;
      scenario = {
        number: marker.group,
        title,
        description: cleanText(questionLines.slice(scenarioIndex + 1, firstScenarioQuestion)),
      };
      scenarios.set(scenario.number, scenario);
    }
    const format = marker.header.split(" · ")[0].toLowerCase();
    const type = {
      "multiple choice": "single_choice",
      "multiple response": "multiple_response",
      "scenario matching": "scenario_matching",
    }[format];
    if (!type) fail(`${kind} ${marker.key}: unsupported type ${format}`);
    const countWord = marker.header.match(/select (ONE|TWO|THREE|FOUR)/)?.[1];
    let selectionCount = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4 }[countWord];
    const options = [];
    const matchItems = [];
    let prompt;
    if (type === "scenario_matching") {
      const firstItem = block.findIndex((line) => /^\d+\.\s+/.test(line));
      const optionStart = block.findIndex((line) => line.startsWith("Options:"));
      if (firstItem < 0 || optionStart < firstItem)
        fail(`${kind} ${marker.key}: ambiguous matching layout`);
      prompt = cleanText(block.slice(0, firstItem));
      for (const line of block.slice(firstItem, optionStart)) {
        const item = line.match(/^(\d+)\.\s+(.*)$/);
        if (item) matchItems.push({ key: item[1], text: item[2] });
        else matchItems.at(-1).text += ` ${line}`;
      }
      cleanText(block.slice(optionStart))
        .replace(/^Options:\s*/, "")
        .split(" · ")
        .forEach((text, ordinal) => options.push({ key: String.fromCharCode(65 + ordinal), text }));
      selectionCount = matchItems.length;
    } else {
      if (!selectionCount || (type === "single_choice" && selectionCount !== 1))
        fail(`${kind} ${marker.key}: missing selection count`);
      const firstOption = block.findIndex((line) => /^[A-Z]\.\s+/.test(line));
      if (firstOption < 0) fail(`${kind} ${marker.key}: no options`);
      prompt = cleanText(block.slice(0, firstOption));
      for (const line of block.slice(firstOption)) {
        const option = line.match(/^([A-Z])\.\s+(.*)$/);
        if (option) options.push({ key: option[1], text: option[2] });
        else options.at(-1).text += ` ${line}`;
      }
    }
    if (
      !prompt ||
      options.length < 2 ||
      options.some((item, ordinal) => !item.text || item.key !== String.fromCharCode(65 + ordinal))
    )
      fail(`${kind} ${marker.key}: invalid prompt/options`);
    const answer = answers.get(marker.key);
    if (!answer) fail(`${kind} ${marker.key}: missing answer`);
    let reviewNote = null;
    let correctKeys;
    let rationaleLines = [...answer.body];
    if (type === "scenario_matching") {
      let mapping = answer.header;
      // Answer mappings wrap across lines. Consume only until every source option resolves.
      const parseMapping = () =>
        mapping.split(/;\s*/).map((part) => {
          const match = part.match(/^(\d+)\s*→\s*(.*)$/);
          const option =
            match &&
            options.find((item) => item.text.toLowerCase() === match[2].trim().toLowerCase());
          return match && option ? `${match[1]}:${option.key}` : null;
        });
      while (true) {
        correctKeys = parseMapping();
        if (correctKeys.length === matchItems.length && correctKeys.every(Boolean)) break;
        if (!rationaleLines.length || mapping.length > 1500)
          fail(`${kind} ${marker.key}: unmapped matching answer`);
        mapping += ` ${rationaleLines.shift()}`;
      }
      if (
        matchItems.some((item, ordinal) => item.key !== String(ordinal + 1)) ||
        new Set(correctKeys.map((key) => key.split(":")[0])).size !== matchItems.length ||
        correctKeys.some((key) => !matchItems.some((item) => item.key === key.split(":")[0]))
      )
        fail(`${kind} ${marker.key}: invalid matching item keys`);
    } else {
      if (!answer.header.startsWith("Correct: ")) fail(`${kind} ${marker.key}: unsupported answer`);
      correctKeys = answer.header
        .slice("Correct: ".length)
        .split(",")
        .map((key) => key.trim());
      if (
        new Set(correctKeys).size !== correctKeys.length ||
        correctKeys.some((key) => !options.some((item) => item.key === key))
      )
        fail(`${kind} ${marker.key}: invalid answer keys (${correctKeys})`);
      if (correctKeys.length !== selectionCount) {
        // Known source inconsistency is retained verbatim and excluded from grading.
        // Unexpected/new inconsistencies still stop import for review.
        if (
          kind !== "developer" ||
          marker.key !== "5.9" ||
          type !== "single_choice" ||
          correctKeys.join(",") !== "A,D"
        )
          fail(`${kind} ${marker.key}: answer count does not match selection count`);
        reviewNote =
          "Source discrepancy: this question requests one answer, but the PDF answer key lists A, D. Its rationale describes option C and rejects A and D. Source content is preserved; this question is excluded from scoring pending source review.";
      }
    }
    const rationale = cleanText(rationaleLines);
    if (!rationale) fail(`${kind} ${marker.key}: missing rationale`);
    questions.push({
      sourceKey: marker.key,
      ordinal: index + 1,
      type,
      selectionCount,
      prompt,
      domain,
      scenario,
      options,
      matchItems,
      sourcePage: lines[marker.index].page,
      reviewNote,
      answer: { correctKeys, rationale },
    });
  }
  if (
    questions.length !== expectedCounts[kind] ||
    answers.size !== questions.length ||
    [...answers.keys()].some((key) => !seen.has(key))
  )
    fail(
      `${kind}: expected ${expectedCounts[kind]} questions and answers, found ${questions.length}/${answers.size}`,
    );
  for (const domain of blueprint) {
    const actual = questions.filter((question) => question.domain.number === domain.number).length;
    if (actual !== domain.count)
      fail(`${kind}: domain ${domain.number} blueprint expects ${domain.count}, found ${actual}`);
  }
  if (
    kind === "foundations" &&
    (scenarios.size !== 6 || [...groupCounts.values()].some((count) => count !== 10))
  )
    fail(`${kind}: expected six scenarios of ten questions`);
  return {
    ...def,
    title: texts[0],
    kind,
    disclaimer,
    timeLimit: Number(time[1]),
    version: texts.find((line) => line.includes("Exam Guide v1.0")),
    domains: blueprint,
    scenarios: [...scenarios.values()],
    questions,
  };
}

const parsed = Object.entries(definitions).map(([kind, def]) => parsePdf(def, kind));
const flagged = parsed.flatMap((exam) =>
  exam.questions
    .filter((question) => question.reviewNote)
    .map((question) => ({ key: `${exam.kind}-${question.sourceKey}`, note: question.reviewNote })),
);
for (const item of flagged) console.error(`SOURCE REVIEW REQUIRED — ${item.key}: ${item.note}`);
if (process.argv.includes("--strict") && flagged.length)
  fail(`${flagged.length} source discrepancy requires review (strict validation)`);
const knownFiles = new Set(Object.values(definitions).map((def) => def.file));
for (const file of fs.readdirSync(pdfDir).filter((file) => /\.pdf$/i.test(file))) {
  if (!knownFiles.has(file))
    fail(`Unreviewed PDF ${file}; add and validate its source definition before seeding`);
}
const db = new Database(dbPath);
db.exec(schema);
function addColumn(table, name, type) {
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((column) => column.name === name)
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumn("certifications", "time_limit_minutes", "INTEGER");
addColumn("certifications", "source_version", "TEXT");
addColumn("certifications", "updated_at", "TEXT");
addColumn("questions", "updated_at", "TEXT");
addColumn("questions", "review_required", "INTEGER NOT NULL DEFAULT 0");
addColumn("questions", "review_note", "TEXT");
addColumn("domains", "blueprint_weight", "REAL");
addColumn("domains", "blueprint_count", "INTEGER");
addColumn("scenarios", "description", "TEXT");
const upsertCertification = db.prepare(
  `INSERT INTO certifications (slug, title, short_title, description, question_count, domain_count, time_limit_minutes, source_file, disclaimer, source_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, short_title=excluded.short_title, description=excluded.description, question_count=excluded.question_count, domain_count=excluded.domain_count, time_limit_minutes=excluded.time_limit_minutes, source_file=excluded.source_file, disclaimer=excluded.disclaimer, source_version=excluded.source_version, updated_at=CURRENT_TIMESTAMP RETURNING id`,
);
const upsertDomain = db.prepare(
  `INSERT INTO domains (certification_id, number, name, blueprint_weight, blueprint_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(certification_id, number) DO UPDATE SET name=excluded.name, blueprint_weight=excluded.blueprint_weight, blueprint_count=excluded.blueprint_count RETURNING id`,
);
const upsertScenario = db.prepare(
  `INSERT INTO scenarios (certification_id, number, title, description) VALUES (?, ?, ?, ?) ON CONFLICT(certification_id, number) DO UPDATE SET title=excluded.title, description=excluded.description RETURNING id`,
);
const upsertQuestion = db.prepare(
  `INSERT INTO questions (certification_id, domain_id, scenario_id, source_key, ordinal, type, prompt, selection_count, source_page, review_required, review_note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(source_key) DO UPDATE SET certification_id=excluded.certification_id, domain_id=excluded.domain_id, scenario_id=excluded.scenario_id, ordinal=excluded.ordinal, type=excluded.type, prompt=excluded.prompt, selection_count=excluded.selection_count, source_page=excluded.source_page, review_required=excluded.review_required, review_note=excluded.review_note, updated_at=CURRENT_TIMESTAMP RETURNING id`,
);
const upsertOption = db.prepare(
  `INSERT INTO options (question_id, option_key, text, ordinal) VALUES (?, ?, ?, ?) ON CONFLICT(question_id, option_key) DO UPDATE SET text=excluded.text, ordinal=excluded.ordinal`,
);
const upsertMatch = db.prepare(
  `INSERT INTO match_items (question_id, item_key, text, ordinal) VALUES (?, ?, ?, ?) ON CONFLICT(question_id, item_key) DO UPDATE SET text=excluded.text, ordinal=excluded.ordinal`,
);
const upsertAnswer = db.prepare(
  `INSERT INTO answers (question_id, correct_keys, rationale) VALUES (?, ?, ?) ON CONFLICT(question_id) DO UPDATE SET correct_keys=excluded.correct_keys, rationale=excluded.rationale`,
);
let inserted = 0;
let updated = 0;
let removedStaleChildren = 0;
const seed = db.transaction(() => {
  for (const exam of parsed) {
    const certification = upsertCertification.get(
      exam.slug,
      exam.title,
      exam.shortTitle,
      exam.description,
      exam.questions.length,
      exam.domains.length,
      exam.timeLimit,
      `pdf/${exam.file}`,
      exam.disclaimer,
      exam.version,
    );
    const domainIds = new Map();
    for (const domain of exam.domains)
      domainIds.set(
        domain.number,
        upsertDomain.get(certification.id, domain.number, domain.name, domain.weight, domain.count)
          .id,
      );
    const scenarioIds = new Map();
    for (const scenario of exam.scenarios)
      scenarioIds.set(
        scenario.number,
        upsertScenario.get(certification.id, scenario.number, scenario.title, scenario.description)
          .id,
      );
    const sourceKeys = exam.questions.map((question) => `${exam.kind}-${question.sourceKey}`);
    const unexpected = db
      .prepare("SELECT source_key FROM questions WHERE certification_id = ?")
      .all(certification.id)
      .filter((row) => !sourceKeys.includes(row.source_key));
    if (unexpected.length)
      fail(
        `${exam.kind}: existing questions absent from PDF: ${unexpected.map((row) => row.source_key).join(", ")}; review required`,
      );
    for (const question of exam.questions) {
      const sourceKey = `${exam.kind}-${question.sourceKey}`;
      const existing = db.prepare("SELECT id FROM questions WHERE source_key = ?").get(sourceKey);
      if (existing) updated++;
      else inserted++;
      const { id: questionId } = upsertQuestion.get(
        certification.id,
        domainIds.get(question.domain.number),
        question.scenario ? scenarioIds.get(question.scenario.number) : null,
        sourceKey,
        question.ordinal,
        question.type,
        question.prompt,
        question.selectionCount,
        question.sourcePage,
        question.reviewNote ? 1 : 0,
        question.reviewNote,
      );
      question.options.forEach((option, index) =>
        upsertOption.run(questionId, option.key, option.text, index + 1),
      );
      question.matchItems.forEach((item, index) =>
        upsertMatch.run(questionId, item.key, item.text, index + 1),
      );
      // Earlier imports accidentally parsed page footers as matching options. Reconcile
      // derived child records to the fully validated PDF while preserving question IDs.
      for (const stale of db
        .prepare("SELECT id, option_key FROM options WHERE question_id = ?")
        .all(questionId)) {
        if (!question.options.some((option) => option.key === stale.option_key))
          removedStaleChildren += db
            .prepare("DELETE FROM options WHERE id = ?")
            .run(stale.id).changes;
      }
      for (const stale of db
        .prepare("SELECT id, item_key FROM match_items WHERE question_id = ?")
        .all(questionId)) {
        if (!question.matchItems.some((item) => item.key === stale.item_key))
          removedStaleChildren += db
            .prepare("DELETE FROM match_items WHERE id = ?")
            .run(stale.id).changes;
      }
      upsertAnswer.run(
        questionId,
        JSON.stringify(question.answer.correctKeys),
        question.answer.rationale,
      );
    }
  }
  if (db.pragma("foreign_key_check").length) fail("foreign key integrity check failed");
});
try {
  seed();
  for (const exam of parsed)
    console.log(
      `${exam.title}: ${exam.questions.length} questions, ${exam.domains.length} domains, ${exam.timeLimit} minutes`,
    );
  if (removedStaleChildren)
    console.warn(
      `Repaired ${removedStaleChildren} stale child records from previous extraction; validated PDF content retained and question IDs preserved.`,
    );
  console.log(
    `Questions inserted: ${inserted}; updated: ${updated}; validation errors: 0; flagged source discrepancies: ${flagged.length}`,
  );
} finally {
  db.close();
}
