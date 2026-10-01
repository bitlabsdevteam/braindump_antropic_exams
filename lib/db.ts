import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Answer, Certification, Question } from "./types";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "exams.db");
let db: Database.Database | undefined;

function getDb() {
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function getCertifications(): Certification[] {
  return getDb().prepare("SELECT id, slug, title, short_title as shortTitle, description, question_count as questionCount, domain_count as domainCount, time_limit_minutes as timeLimitMinutes, source_file as sourceFile FROM certifications ORDER BY id").all() as Certification[];
}

export function getCertification(slug: string): Certification | undefined {
  return getDb().prepare("SELECT id, slug, title, short_title as shortTitle, description, question_count as questionCount, domain_count as domainCount, time_limit_minutes as timeLimitMinutes, source_file as sourceFile FROM certifications WHERE slug = ?").get(slug) as Certification | undefined;
}

export function getQuestions(slug: string): Question[] {
  const certification = getCertification(slug);
  if (!certification) return [];
  const rows = getDb().prepare(`SELECT q.id, q.source_key as sourceKey, q.ordinal, q.type, q.prompt, q.selection_count as selectionCount, d.number as domainNumber, d.name as domainName, s.number as scenarioNumber, s.title as scenarioTitle FROM questions q LEFT JOIN domains d ON d.id = q.domain_id LEFT JOIN scenarios s ON s.id = q.scenario_id WHERE q.certification_id = ? ORDER BY q.ordinal`).all(certification.id) as Omit<Question, "options" | "matchItems">[];
  const optionStmt = getDb().prepare("SELECT option_key as key, text, ordinal FROM options WHERE question_id = ? ORDER BY ordinal");
  const matchStmt = getDb().prepare("SELECT item_key as key, text, ordinal FROM match_items WHERE question_id = ? ORDER BY ordinal");
  return rows.map((row) => ({ ...row, options: optionStmt.all(row.id) as Question["options"], matchItems: matchStmt.all(row.id) as Question["matchItems"] }));
}

export function getQuestion(questionId: number): Question | undefined {
  const row = getDb().prepare(`SELECT q.id, q.source_key as sourceKey, q.ordinal, q.type, q.prompt, q.selection_count as selectionCount, d.number as domainNumber, d.name as domainName, s.number as scenarioNumber, s.title as scenarioTitle FROM questions q LEFT JOIN domains d ON d.id = q.domain_id LEFT JOIN scenarios s ON s.id = q.scenario_id WHERE q.id = ?`).get(questionId) as Omit<Question, "options" | "matchItems"> | undefined;
  if (!row) return undefined;
  const options = getDb().prepare("SELECT option_key as key, text, ordinal FROM options WHERE question_id = ? ORDER BY ordinal").all(questionId) as Question["options"];
  const matchItems = getDb().prepare("SELECT item_key as key, text, ordinal FROM match_items WHERE question_id = ? ORDER BY ordinal").all(questionId) as Question["matchItems"];
  return { ...row, options, matchItems };
}

export function getCertificationForQuestion(questionId: number): Certification | undefined {
  return getDb().prepare(`SELECT c.id, c.slug, c.title, c.short_title as shortTitle, c.description, c.question_count as questionCount, c.domain_count as domainCount, c.time_limit_minutes as timeLimitMinutes, c.source_file as sourceFile FROM certifications c JOIN questions q ON q.certification_id = c.id WHERE q.id = ?`).get(questionId) as Certification | undefined;
}

export function getAnswer(questionId: number): Answer | undefined {
  const row = getDb().prepare("SELECT correct_keys as correctKeys, rationale FROM answers WHERE question_id = ?").get(questionId) as { correctKeys?: string; rationale: string } | undefined;
  if (!row) return undefined;
  return { correctKeys: JSON.parse(row.correctKeys ?? "[]") as string[], rationale: row.rationale };
}

export function getDomains(slug: string) {
  const certification = getCertification(slug);
  if (!certification) return [] as { number: number; name: string; questionCount: number }[];
  return getDb().prepare("SELECT d.number, d.name, COUNT(q.id) as questionCount FROM domains d LEFT JOIN questions q ON q.domain_id = d.id WHERE d.certification_id = ? GROUP BY d.id ORDER BY d.number").all(certification.id) as { number: number; name: string; questionCount: number }[];
}
