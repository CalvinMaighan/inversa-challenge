/**
 * "Ask next" suggestions: after an answer, Fastino's GLiNER2.5-Decide scores the app's own supported questions (the Questions
 * tab) against what the person just asked and was told, and the best three are offered. A classifier ranks written options, it
 * writes none, so every suggestion is a question the agent is known to answer. Empty without a key.
 */
import { scoreLabels, type ClassifyOptions } from "@/server/fastino/gliner";
import { questionGroups } from "@/shared/apps/question-catalog";
import type { AppConfig } from "@/shared/apps";

const MAX_SUGGESTIONS = 3;
/** Options scored below this are noise, not a suggestion. */
const MIN_CONFIDENCE = 0.1;

/** The questions that can be offered: every topic's, except the hands-free and map ones, which do not follow from an answer. */
export function candidateQuestions(app: AppConfig): string[] {
  return questionGroups(app)
    .filter((g) => g.id !== "map" && g.id !== "voice")
    .flatMap((g) => g.questions);
}

export type FollowUpInput = { app: AppConfig; question: string; answer: string; asked?: readonly string[]; signal?: AbortSignal; classify?: ClassifyOptions };

export async function suggestFollowUps({ app, question, answer, asked = [], signal, classify }: FollowUpInput): Promise<string[]> {
  const askedSet = new Set(asked.map((q) => q.trim().toLowerCase()));
  askedSet.add(question.trim().toLowerCase());
  const pool = candidateQuestions(app).filter((q) => !askedSet.has(q.toLowerCase()));
  const text = `The user asked: ${question.slice(0, 300)}\nThe answer: ${answer.slice(0, 900)}`;
  const scored = await scoreLabels(text, pool, { signal, ...classify });
  if (!scored) return [];
  return scored.filter((s) => s.confidence >= MIN_CONFIDENCE).slice(0, MAX_SUGGESTIONS).map((s) => s.label);
}
