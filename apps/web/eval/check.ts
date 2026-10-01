/**
 * Per-question checks for the live eval (docs/grading/rubric.md "Agent and eval"): the golden's `pass`
 * criteria (phrases, forbid patterns, mode), required tools, citations by kind and by feed (`mustCite`),
 * the numbers trace (every number in the answer appears in some tool output, unit conversions allowed) and
 * the feed-state disclosure. The numbers trace and the disclosure are the runtime's own generic checks
 * (server/agent/answer-check.ts); the golden criteria live here and in the question files only, never in
 * anything the agent reads. Pure over the event stream plus the captured model-facing tool outputs.
 */

import type { Golden } from "./golden";

import { feedStateDisclosed, numbersTrace, plainQuotes, type ToolCapture } from "@/server/agent/answer-check";
import { citedIds } from "@/server/agent/cordis/citations";
import type { Evidence } from "@/server/agent/runtime/registry";
import type { AgentStreamEvent } from "@/shared/agent/events";

export { extractNumbers, feedStateDisclosed, numbersTrace, toolNumbers, type NumbersTrace, type ToolCapture } from "@/server/agent/answer-check";

// ---------------------------------------------------------------- citations

/** `feed:x` is satisfied by a cited evidence row from feed x (prefix match: nws covers nws-alerts and nws-forecast). */
export function feedCited(cited: readonly string[], evidenceById: ReadonlyMap<string, Evidence>, feed: string): boolean {
  return cited.some((id) => {
    const source = evidenceById.get(id)?.feed;
    return !!source && (source === feed || source.startsWith(`${feed}-`));
  });
}

export function mustCiteOk(cited: readonly string[], evidenceById: ReadonlyMap<string, Evidence>, mustCite: readonly string[]): string[] {
  const reasons: string[] = [];
  for (const need of mustCite) {
    const [kind, value] = need.split(":") as [string, string];
    if (kind === "feed" && !feedCited(cited, evidenceById, value)) reasons.push(`no citation from feed ${value}`);
    if (kind === "kind" && !cited.some((id) => id.startsWith(`${value}:`))) reasons.push(`no ${value}: citation`);
  }
  return reasons;
}

// ---------------------------------------------------------------- the pass bars

/** The pass bars (docs/grading/rubric.md "The live eval"): rates for a stochastic model, strict where it must be. */
export const BARS = { overall: 95, category: 90, boundary: 100, ungrounded: 0 } as const;

/** Whole percent, rounded down: 65/69 is 94, not 95. */
export const pct = (p: number, t: number) => (t === 0 ? 100 : Math.floor((p / t) * 100));

/** Whether a run meets the bars: overall, every category, boundary exactly, no ungrounded number. */
export function barsMet(passed: number, total: number, byCategory: ReadonlyMap<string, { passed: number; total: number }>, ungrounded: number): boolean {
  if (pct(passed, total) < BARS.overall || ungrounded > BARS.ungrounded) return false;
  for (const [category, row] of byCategory) {
    if (pct(row.passed, row.total) < (category === "boundary" ? BARS.boundary : BARS.category)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- the whole check

export type QuestionCheck = { reasons: string[]; tools: string[]; cited: string[]; trace: ReturnType<typeof numbersTrace> };

export function checkQuestion(golden: Golden, events: readonly AgentStreamEvent[], captures: readonly ToolCapture[]): QuestionCheck {
  const reasons: string[] = [];
  const done = events.filter((event) => event.type === "done");
  if (done.length !== 1 || events.at(-1)?.type !== "done") reasons.push("stream must end with exactly one done event");
  for (const event of events) if (event.type === "error") reasons.push(`error event: ${event.message}`);

  const tools = events.flatMap((event) => (event.type === "tool_start" ? [event.capabilityName] : []));
  for (const tool of golden.expect.tools) if (!tools.includes(tool)) reasons.push(`tool not called: ${tool}`);
  if (golden.mode === "refuse" && tools.length > 0 && golden.expect.tools.length === 0) reasons.push(`refusal called tools: ${tools.join(", ")}`);

  const evidenceById = new Map<string, Evidence>();
  for (const event of events) {
    if (event.type !== "tool_end" || !event.ok) continue;
    for (const row of (event.data as { evidence?: Evidence[] } | undefined)?.evidence ?? []) evidenceById.set(row.id, row);
  }
  for (const event of events) {
    if (event.type === "citation" && !evidenceById.has(event.id)) reasons.push(`citation event for unreturned id ${event.id}`);
  }
  // Typographic quotes read as ASCII and markdown emphasis is dropped, as the pass regexes are written.
  const content = plainQuotes(done[0]?.type === "done" ? done[0].content : "");
  const cited = [...new Set(citedIds(content))];
  for (const id of cited) if (!evidenceById.has(id)) reasons.push(`final text cites unreturned id ${id}`);
  if (cited.length < golden.expect.minCitations) reasons.push(`${cited.length} citations, need ${golden.expect.minCitations}`);
  for (const [kind, need] of Object.entries(golden.expect.cites ?? {})) {
    const got = cited.filter((id) => id.startsWith(`${kind}:`)).length;
    if (got < need) reasons.push(`${got} ${kind} citations, need ${need}`);
  }
  reasons.push(...mustCiteOk(cited, evidenceById, golden.mustCite ?? []));
  for (const phrase of golden.expect.phrases) if (!phrase.test(content)) reasons.push(`missing phrase ${phrase}`);
  for (const phrase of golden.expect.forbid ?? []) if (phrase.test(content)) reasons.push(`forbidden phrase ${phrase}`);
  if (golden.expect.view && !events.some((event) => event.type === "view")) reasons.push("no view event");

  const trace = golden.expect.groundedNumbers === false ? { checked: 0, ungrounded: [] } : numbersTrace(content, captures.map((c) => c.text), golden.question);
  if (trace.ungrounded.length) reasons.push(`ungrounded numbers: ${trace.ungrounded.map((n) => n.raw).join(", ")}`);
  if (golden.expect.feedState) {
    const disclosure = feedStateDisclosed(content, captures.flatMap((c) => c.feeds));
    reasons.push(...disclosure.reasons);
  }
  return { reasons, tools, cited, trace };
}
