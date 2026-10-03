// Only bounded, predefined teaching preferences may cross question boundaries.
export const preferenceValues = {
  depth: ["brief", "detailed"],
  style: ["step_by_step", "examples", "questions"],
  language: [
    "English",
    "Japanese",
    "Spanish",
    "French",
    "German",
    "Korean",
    "Chinese",
    "Portuguese",
  ],
  experience: ["beginner", "intermediate", "advanced"],
} as const;
export type PreferenceKey = keyof typeof preferenceValues;
export type MemoryUpdate = { key: PreferenceKey; value: string | null; evidence: string };
export type MemorySummary = {
  goal: string;
  learningNotes: { text: string; evidenceTurnIds: number[] }[];
  openQuestions: string[];
  nextStep: string;
};
export type MemoryView = {
  expiresAt: number;
  preferences: { key: PreferenceKey; value: string; updatedAt: number }[];
  summary: MemorySummary | null;
  summaryVersion: number | null;
  // Only history from the server-authorized reveal phase is exposed.
  turns: {
    id: number;
    user: string;
    assistant: { message: string; concept: string; nextStep: string };
    createdAt: number;
  }[];
  hasMore: boolean;
  nextBefore: number | null;
  scope: "hidden" | "revealed";
};
