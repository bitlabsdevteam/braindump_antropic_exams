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
  options: Option[];
  matchItems: MatchItem[];
};

export type Answer = { correctKeys: string[]; rationale: string };

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
};
