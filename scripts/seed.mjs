import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const root = process.cwd();
const pdfDir = path.join(root, "pdf");
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "exams.db");
fs.mkdirSync(dataDir, { recursive: true });

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
  professional: { file: "1783837911603.pdf", slug: "architect-professional", title: "Claude Certified Architect – Professional", shortTitle: "Architect – Professional", description: "A full-length set covering solution design, context engineering, integration, evaluation, governance, stakeholder communication, and developer enablement." },
  foundations: { file: "1786162352230.pdf", slug: "architect-foundations", title: "Claude Certified Architect – Foundations", shortTitle: "Architect – Foundations", description: "A scenario-based set covering agentic architecture, MCP integration, Claude Code workflows, structured output, and reliable context management." },
  developer: { file: "1784425506971.pdf", slug: "developer-foundations", title: "Claude Certified Developer – Foundations", shortTitle: "Developer – Foundations", description: "A full-length set covering agents and workflows, applications and integration, Claude Code, evaluation, model optimization, prompting, safety, and MCP tools." },
  associate: { file: "1784425984382.pdf", slug: "associate-foundations", title: "Claude Certified Associate – Foundations", shortTitle: "Associate – Foundations", description: "A full-length set covering prompting, output validation, product and model selection, workflow integration, configuration, governance, and troubleshooting." },
};

function cleanLine(line) {
  return line.replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\s+$/, "").trim();
}

function cleanText(lines) {
  return lines.filter((line) => line && !line.startsWith("CCAR-") && !/^\d+$/.test(line)).join(" ").replace(/\s+/g, " ").trim();
}

function parsePdf(def, kind) {
  const filePath = path.join(pdfDir, def.file);
  const raw = execFileSync("pdftotext", ["-layout", filePath, "-"], { encoding: "utf8" });
  const text = raw.replace(/\r/g, "");
  const answerStart = text.indexOf("Detailed reasoning");
  const questionText = answerStart > -1 ? text.slice(0, answerStart) : text;
  const answersText = answerStart > -1 ? text.slice(answerStart).replace(/\f/g, "\n") : "";
  const marker = /Question (\d+)\.(\d+) · ([^\n]+)\n/g;
  const markers = [...questionText.matchAll(marker)];
  const answerMap = new Map();
  const answerRegex = /^(\d+\.\d+) — (.+)$/gm;
  const answerMatches = [...answersText.matchAll(answerRegex)];
  for (let i = 0; i < answerMatches.length; i++) {
    const match = answerMatches[i];
    const nextStart = i + 1 < answerMatches.length ? answerMatches[i + 1].index : answersText.length;
    const body = answersText.slice(match.index + match[0].length, nextStart);
    const line = match[2].trim();
    let correctKeys = [];
    if (line.startsWith("Correct:")) correctKeys = line.replace("Correct:", "").split(",").map((key) => key.trim()).filter(Boolean);
    else correctKeys = [...line.matchAll(/\d+\s*→\s*[^;]+?(?=;|$)/g)].map((entry) => entry[0].trim());
    answerMap.set(match[1], { correctKeys, rationale: cleanText(body.split("\n")).replace(/^Why not the others:\s*/i, "Why not the others: ").trim() || line });
  }

  let currentDomain = null;
  let currentScenario = null;
  const domains = new Map();
  const scenarios = new Map();
  const questions = [];
  for (let i = 0; i < markers.length; i++) {
    const match = markers[i];
    const sourceKey = `${match[1]}.${match[2]}`;
    const block = questionText.slice(match.index + match[0].length, i + 1 < markers.length ? markers[i + 1].index : questionText.length);
    const before = questionText.slice(Math.max(0, match.index - 700), match.index);
    const domainMatch = [...before.matchAll(/(?:Domain (\d+):\s*)([^\n(]+)/g)].at(-1);
    if (domainMatch) { currentDomain = { number: Number(domainMatch[1]), name: cleanLine(domainMatch[2]) }; domains.set(currentDomain.number, currentDomain.name); }
    const scenarioMatch = [...before.matchAll(/Scenario (\d+):\s*([^\n]+)/g)].at(-1);
    if (scenarioMatch) { currentScenario = { number: Number(scenarioMatch[1]), title: cleanLine(scenarioMatch[2]) }; scenarios.set(currentScenario.number, currentScenario.title); }
    const header = match[3];
    const headerDomain = header.match(/Domain (\d+)/i);
    if (headerDomain) {
      const foundationNames = {
        1: "Agentic Architecture & Orchestration",
        2: "Tool Design & MCP Integration",
        3: "Claude Code Configuration & Workflows",
        4: "Prompt Engineering & Structured Output",
        5: "Context Management & Reliability",
      };
      currentDomain = { number: Number(headerDomain[1]), name: foundationNames[Number(headerDomain[1])] ?? `Domain ${headerDomain[1]}` };
      domains.set(currentDomain.number, currentDomain.name);
    }
    const type = header.toLowerCase().includes("scenario matching") ? "scenario_matching" : header.toLowerCase().includes("multiple response") ? "multiple_response" : "single_choice";
    const selectionCount = Number(header.match(/select (?:ONE|TWO)/i)?.[0]?.toLowerCase().includes("two") ? 2 : 1);
    const lines = block.split("\n").map(cleanLine).filter(Boolean);
    const optionIndex = lines.findIndex((line) => /^[A-Z]\.\s+/.test(line));
    const options = [];
    const promptLines = optionIndex > -1 ? lines.slice(0, optionIndex) : lines;
    if (optionIndex > -1 && type !== "scenario_matching") {
      let current = null;
      for (const line of lines.slice(optionIndex)) {
        const optionMatch = line.match(/^([A-Z])\.\s+(.*)$/);
        if (optionMatch) { current = { key: optionMatch[1], text: optionMatch[2] }; options.push(current); }
        else if (current && !line.startsWith("Question ")) current.text += ` ${line}`;
      }
    }
    const matchItems = [];
    if (type === "scenario_matching") {
      const optionLineIndex = lines.findIndex((line) => line.startsWith("Options:"));
      const itemLines = lines.slice(0, optionLineIndex > -1 ? optionLineIndex : lines.length).filter((line) => /^\d+\.?\s+/.test(line));
      let current = null;
      for (const line of itemLines) {
        const itemMatch = line.match(/^(\d+)\.?\s+(.*)$/);
        if (itemMatch) { current = { key: itemMatch[1], text: itemMatch[2] }; matchItems.push(current); }
        else if (current) current.text += ` ${line}`;
      }
      const optionText = optionLineIndex > -1 ? lines.slice(optionLineIndex).join(" ").replace(/^Options:\s*/, "") : "";
      optionText.split(" · ").map((value) => value.trim()).filter(Boolean).forEach((value, index) => options.push({ key: String.fromCharCode(65 + index), text: value }));
    }
    const answer = answerMap.get(sourceKey);
    if (!answer) throw new Error(`Missing answer mapping for ${kind} ${sourceKey}`);
    if (type === "scenario_matching") {
      answer.correctKeys = answer.correctKeys.map((mapping) => {
        const parsedMapping = mapping.match(/^(\d+)\s*→\s*(.*)$/);
        if (!parsedMapping) return mapping;
        const option = options.find((candidate) => candidate.text.toLowerCase() === parsedMapping[2].trim().toLowerCase());
        return `${parsedMapping[1]}:${option?.key ?? parsedMapping[2].trim()}`;
      });
    }
    questions.push({ sourceKey, ordinal: questions.length + 1, type, selectionCount, prompt: cleanText(promptLines), domain: currentDomain, scenario: currentScenario, options, matchItems, answer });
  }
  return { ...def, kind, domains: [...domains.entries()].map(([number, name]) => ({ number, name })), scenarios: [...scenarios.entries()].map(([number, title]) => ({ number, title })), questions };
}

const parsed = Object.entries(definitions).map(([kind, def]) => parsePdf(def, kind));
const db = new Database(dbPath);
db.exec(schema);
try { db.exec("ALTER TABLE certifications ADD COLUMN time_limit_minutes INTEGER"); } catch (error) { if (!String(error).includes("duplicate column name")) throw error; }
const insertCertification = db.prepare("INSERT INTO certifications (slug, title, short_title, description, question_count, domain_count, time_limit_minutes, source_file, disclaimer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertDomain = db.prepare("INSERT INTO domains (certification_id, number, name) VALUES (?, ?, ?)");
const insertScenario = db.prepare("INSERT INTO scenarios (certification_id, number, title) VALUES (?, ?, ?)");
const insertQuestion = db.prepare("INSERT INTO questions (certification_id, domain_id, scenario_id, source_key, ordinal, type, prompt, selection_count, source_page) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertOption = db.prepare("INSERT INTO options (question_id, option_key, text, ordinal) VALUES (?, ?, ?, ?)");
const insertMatch = db.prepare("INSERT INTO match_items (question_id, item_key, text, ordinal) VALUES (?, ?, ?, ?)");
const insertAnswer = db.prepare("INSERT INTO answers (question_id, correct_keys, rationale) VALUES (?, ?, ?)");
const seed = db.transaction(() => {
  db.exec("DELETE FROM certifications");
  for (const exam of parsed) {
    const certification = insertCertification.run(exam.slug, exam.title, exam.shortTitle, exam.description, exam.questions.length, exam.domains.length, 120, `pdf/${exam.file}`, "Independent practice content; not official live-exam content.");
    const domainIds = new Map();
    for (const domain of exam.domains) domainIds.set(domain.number, Number(insertDomain.run(certification.lastInsertRowid, domain.number, domain.name).lastInsertRowid));
    const scenarioIds = new Map();
    for (const scenario of exam.scenarios) scenarioIds.set(scenario.number, Number(insertScenario.run(certification.lastInsertRowid, scenario.number, scenario.title).lastInsertRowid));
    for (const question of exam.questions) {
      const result = insertQuestion.run(certification.lastInsertRowid, question.domain ? domainIds.get(question.domain.number) ?? null : null, question.scenario ? scenarioIds.get(question.scenario.number) ?? null : null, `${exam.kind}-${question.sourceKey}`, question.ordinal, question.type, question.prompt, question.type === "scenario_matching" ? question.matchItems.length : question.selectionCount, null);
      const questionId = Number(result.lastInsertRowid);
      question.options.forEach((option, index) => insertOption.run(questionId, option.key, option.text, index + 1));
      question.matchItems.forEach((item, index) => insertMatch.run(questionId, item.key, item.text, index + 1));
      insertAnswer.run(questionId, JSON.stringify(question.answer.correctKeys), question.answer.rationale);
    }
  }
});
seed();
db.close();
for (const exam of parsed) console.log(`${exam.title}: ${exam.questions.length} questions, ${exam.domains.length} domains`);
