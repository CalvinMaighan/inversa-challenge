/**
 * The supported chat questions of an app (`spec/apps/questions/<app>.json`, rendered to docs/questions.md by
 * `scripts/check-questions.ts`): the set the UI offers as starter chips and the eval harness runs as its golden
 * set. The agent never sees them: no prompt, hint or answer check reads this file (tests/server/agent/
 * no-answer-key.test.ts). Pure: no runtime globals.
 */
import carpQuestions from "app-configs/questions/carp.json";
import lionfishQuestions from "app-configs/questions/lionfish.json";
import pythonQuestions from "app-configs/questions/python.json";

import type { AppId } from "./schema";

export type SupportedQuestion = {
  id: string;
  category: string;
  question: string;
  intent?: string;
  expectedTools: string[];
  mustCite: string[];
  view?: { map?: string; timeline?: string };
  context?: Record<string, string>;
  pass: {
    mode: "answer" | "caveat" | "refuse";
    /** Plain-language statements the answer must make (judged semantically, eval/judge.ts). */
    mustSay?: string[];
    /** Legacy regex phrases, present only in a file `scripts/migrate-phrases-to-mustsay.ts` has not converted yet. */
    phrases?: string[];
    forbid: string[];
    groundedNumbers: boolean;
    feedState: boolean;
    minCitations: number;
    cites?: Record<string, number>;
  };
};

export type QuestionFile = { app: string; questions: SupportedQuestion[] };

const FILES: Partial<Record<AppId, QuestionFile>> = { carp: carpQuestions as QuestionFile, lionfish: lionfishQuestions as QuestionFile, python: pythonQuestions as QuestionFile };

/** The app's question file (every app has one; an unknown app gets an empty set). */
export function supportedQuestions(app: AppId): SupportedQuestion[] {
  return FILES[app]?.questions ?? [];
}

const STOP = new Set(["the", "a", "an", "of", "at", "in", "on", "for", "to", "is", "are", "we", "our", "do", "does", "did", "any", "and", "or", "it", "its", "this", "that", "what", "which", "how", "why", "where", "when", "me", "us", "right", "now", "there", "be", "with", "from", "by", "about", "today", "tonight"]);

/** Lower-case word stems of a question, stop words dropped, plurals and -ing/-ed trimmed. */
export function questionTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      // Suffixes come off only when a stem of 3+ letters remains ("need" stays "need").
      .map((w) => (w.length > 5 ? w.replace(/ing$/, "") : w))
      .map((w) => (w.length > 4 ? w.replace(/(ed|es)$/, "") : w))
      .map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)),
  );
}

/**
 * The supported question closest to `text` (Jaccard overlap of word stems), when it is close enough. Exact
 * questions score 1; a paraphrase that shares most of its words still matches; an unrelated question gets null.
 * For starter-chip routing in the UI only: the agent runtime never calls it.
 */
export function matchSupportedQuestion(app: AppId, text: string, threshold = 0.5): { question: SupportedQuestion; score: number } | null {
  const asked = questionTerms(text);
  if (asked.size === 0) return null;
  let best: { question: SupportedQuestion; score: number } | null = null;
  for (const question of supportedQuestions(app)) {
    const terms = questionTerms(question.question);
    let shared = 0;
    for (const t of asked) if (terms.has(t)) shared += 1;
    const score = shared / (asked.size + terms.size - shared);
    if (score >= threshold && (!best || score > best.score)) best = { question, score };
  }
  return best;
}
