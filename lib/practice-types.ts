import type { Question } from "./types";
import type { PracticeScore } from "./scoring";

export type AttemptKind = "independent" | "assisted" | "review";
export type TutorIntent = "hint" | "concept" | "review" | "follow_up";
export type DraftState = {
  selectedKeys: string[];
  reasoning: string;
  generation: number;
  revision: number;
  hintCount: number;
  submitted: boolean;
  exposed: boolean;
  visible: boolean;
  result: { correct: boolean; kind: AttemptKind } | null;
};
export type DomainProgress = {
  name: string;
  attempted: number;
  independent: number;
  correct: number;
};
export type PracticeResult = {
  score: PracticeScore;
  correct: number;
  total: number;
  attempted: number;
  unanswered: number;
  excluded: number;
  percentage: number;
  independent: number;
  assisted: number;
  review: number;
  unansweredKeys: string[];
  domains: { name: string; correct: number; total: number; attempted: number }[];
};
export type PracticeSnapshot = {
  states: Record<string, DraftState>;
  settings: { questionKey: string | null; started: boolean; deadline: number | null };
  progress: {
    attempted: number;
    independent: number;
    independentCorrect: number;
    assisted: number;
    reviews: number;
    reviewCorrect: number;
    domains: DomainProgress[];
  };
  mistakeKeys: string[];
  expiresAt: number;
  result: PracticeResult;
};
export type Recommendation = Pick<
  Question,
  "id" | "sourceKey" | "prompt" | "domainName" | "scenarioTitle" | "type"
> & { reason: string };
