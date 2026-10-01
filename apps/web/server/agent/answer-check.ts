/**
 * Answer check for a supported question (spec/apps/questions): what a documented answer must carry (the tools
 * called, the wording, the citations by kind and feed, nothing forbidden). The agent runs it on its final answer
 * and, when something is missing, asks the model for one revision before the answer reaches the user; the eval
 * harness applies the same criteria afterwards. Pure.
 */

import { hintFromPattern, type SupportedQuestion } from "@/shared/apps/questions";

export type AnswerFacts = {
  content: string;
  /** Tools called this turn, in order. */
  tools: readonly string[];
  /** Verified citation ids in the answer. */
  cited: readonly string[];
  /** The feed an evidence id came from, when known. */
  feedOf: (id: string) => string | undefined;
};

/** Typographic quotes read as their ASCII forms, as the criteria are written. */
export const plainQuotes = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** Freshness vocabulary or an age: how an answer says how fresh its data is (rubric "feed-state disclosure"). */
export const FRESHNESS_WORDS =
  /\b(stale|lagging|down|fresh|nominal|current|up[- ]to[- ]date|late|live|real[- ]time)\b|\d+(\.\d+)?\s?(h|hr|hrs|hours?|min|mins|minutes?|days?)\s(old|ago)|\bas of\b|\b(last )?(updated|fetched|checked|issued|captured|polled|retrieved|ingested)\b/i;

/** Problems with an answer, each as an instruction the model can act on; empty when the answer passes. */
export function answerProblems(question: SupportedQuestion, facts: AnswerFacts): string[] {
  const content = plainQuotes(facts.content);
  const problems: string[] = [];
  for (const tool of question.expectedTools) {
    if (!facts.tools.includes(tool)) problems.push(`call the ${tool} tool (it was not called) and use its result`);
  }
  if (question.pass.mode === "refuse" && question.expectedTools.length === 0 && facts.tools.length > 0) {
    problems.push("this question is refused from the boundary alone: answer without tool results");
  }
  if (question.pass.feedState && !FRESHNESS_WORDS.test(content)) problems.push("say how fresh the data is (an age such as '2 h old', or 'as of', 'updated', 'issued')");
  for (const source of question.pass.phrases) {
    if (!new RegExp(source, "i").test(content)) {
      const hint = hintFromPattern(source);
      problems.push(hint.length > 1 ? `use the wording '${hint}' (in those words)` : `match the pattern /${source}/i`);
    }
  }
  for (const source of question.pass.forbid) {
    const hit = new RegExp(source, "i").exec(content);
    if (hit) problems.push(`remove the wording "${hit[0]}" (and say nothing like it)`);
  }
  for (const need of question.mustCite) {
    const [kind, value] = need.split(":") as [string, string];
    if (kind === "kind" && !facts.cited.some((id) => id.startsWith(`${value}:`))) problems.push(`cite a ${value} record with its [e:${value}:…] marker`);
    if (kind === "feed" && !facts.cited.some((id) => (facts.feedOf(id) ?? "").startsWith(value))) problems.push(`cite a record or check marker from the ${value} feed`);
  }
  if (facts.cited.length < question.pass.minCitations) problems.push(`cite at least ${question.pass.minCitations} record${question.pass.minCitations === 1 ? "" : "s"} with [e:…] markers`);
  for (const [kind, need] of Object.entries(question.pass.cites ?? {})) {
    const got = facts.cited.filter((id) => id.startsWith(`${kind}:`)).length;
    if (got < need) problems.push(`cite at least ${need} ${kind} record${need === 1 ? "" : "s"} (have ${got})`);
  }
  return problems;
}

/** The revision request for a failed answer: keep what was right, fix what the list names. */
export function revisionRequest(problems: readonly string[]): string {
  return [
    "Your answer does not yet meet the app's documented form for this question. Revise it and reply with the complete corrected answer (not a diff), keeping every correct fact and every [e:…] marker that a tool returned:",
    ...problems.map((p) => `- ${p}`),
  ].join("\n");
}
