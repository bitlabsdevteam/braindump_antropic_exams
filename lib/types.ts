export type QuestionType = "single_choice" | "multiple_response" | "scenario_matching";

export type Option = { key: string; text: string; ordinal: number };
export type MatchItem = { key: string; text: string; ordinal: number };

export type Question = {
  id: number;
  sourceKey: string;
  ordinal: number;
  type: QuestionType;
  prompt: string;
  selectionCount: number;
  domainNumber: number | null;
  domainName: string | null;
  scenarioNumber: number | null;
  scenarioTitle: string | null;
  scenarioDescription: string | null;
  options: Option[];
  matchItems: MatchItem[];
  sourcePage: number | null;
  reviewRequired: boolean;
  reviewNote: string | null;
};

/** Learner coaching that sits beside, never replaces, the source answer and rationale. */
export type StudyNotes = {
  status: "draft" | "reviewed";
  concept: string;
  optionNotes: Record<string, string>;
  mnemonic: string | null;
};

export type Answer = {
  correctKeys: string[];
  rationale: string;
  reviewNote?: string | null;
  study?: StudyNotes;
};

export type Certification = {
  id: number;
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  questionCount: number;
  domainCount: number;
  timeLimitMinutes: number | null;
  sourceFile: string;
  disclaimer: string;
  sourceVersion: string | null;
};
