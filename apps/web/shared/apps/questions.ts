/**
 * The supported chat questions of an app (`spec/apps/questions/<app>.json`, rendered to docs/questions.md by
 * `scripts/check-questions.ts`). The agent's system prompt lists them with the tools and wording each one
 * needs, and the eval harness runs them as its golden set. Pure: no runtime globals.
 */
import carpQuestions from "app-configs/questions/carp.json";

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
  pass: { mode: "answer" | "caveat" | "refuse"; phrases: string[]; forbid: string[]; groundedNumbers: boolean; feedState: boolean; minCitations: number; cites?: Record<string, number> };
};

export type QuestionFile = { app: string; questions: SupportedQuestion[] };

const FILES: Partial<Record<AppId, QuestionFile>> = { carp: carpQuestions as QuestionFile };

/** The app's question file, or an empty set for an app whose set is hand-written elsewhere. */
export function supportedQuestions(app: AppId): SupportedQuestion[] {
  return FILES[app]?.questions ?? [];
}

/**
 * A readable wording hint from a pass regex: the first alternative of each group, regex syntax dropped.
 * `needs? (operational )?review` becomes "needs operational review"; `\bft\b|feet` becomes "ft".
 */
export function hintFromPattern(source: string): string {
  let s = source
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\(\?<!?[^)]*\)/g, "")
    .replace(/\\[bB]/g, "")
    .replace(/\(\?:/g, "(")
    // A character class stands for its first character ("low[- ]water" reads "low-water").
    .replace(/\[\^[^\]]*\]/g, " ")
    .replace(/\[([^\]])[^\]]*\]/g, "$1");
  // Innermost groups first: keep the first alternative, drop a trailing optional marker.
  for (let i = 0; i < 6 && /\([^()]*\)/.test(s); i++) s = s.replace(/\(([^()]*)\)\??/g, (_, inner: string) => inner.split("|")[0] ?? "");
  s = s.split("|")[0] ?? "";
  return s
    .replace(/\[[^\]]*\]\{[^}]*\}|\{\d+(,\d*)?\}|[*+]|\\d|\\s|\\w|\\\.|[\\^$]/g, " ")
    .replace(/\?/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

/** One prompt line per question: what to call, what to say, what to cite. */
export function questionLine(q: SupportedQuestion): string {
  const tools = q.expectedTools.length ? `call ${q.expectedTools.join(", then ")}` : "call no tool";
  const mode = q.pass.mode === "refuse" ? "; refuse with the boundary" : q.pass.mode === "caveat" ? "; answer, then end with the sentence 'This is conditions only: it cannot judge safety or access.'" : "";
  const say = q.pass.phrases.map(hintFromPattern).filter((h) => h.length > 1 && h.length < 48 && /[a-z°].*[a-z°]|^[a-z°]{2,}$/i.test(h) && !/^[:.,;]/.test(h));
  const cite = q.mustCite.map((c) => c.replace(/^kind:/, "a ").replace(/^feed:/, "feed ")).join(", ");
  const context = q.context?.selectedSite ? ` (the selected site, ${q.context.selectedSite}, is "this location")` : "";
  return `- "${q.question}"${context}: ${tools}${mode}${say.length ? `; wording: ${say.map((h) => `'${h}'`).join(", ")}` : ""}${cite ? `; cite ${cite}` : ""}.`;
}
