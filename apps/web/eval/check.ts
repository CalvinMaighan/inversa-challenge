/**
 * Per-question checks for the live eval (docs/grading/rubric.md "Agent and eval"): the golden's `pass`
 * criteria (forbid patterns, mode; the `mustSay` statements go to the judge in run.ts), required tools, citations by kind and by feed (`mustCite`),
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

// ---------------------------------------------------------------- pooled runs

/** One run's tallies, as `--runs N` collects them. */
export type RunTally = {
  passed: number;
  total: number;
  byCategory: ReadonlyMap<string, { passed: number; total: number }>;
  ungrounded: number;
  checked: number;
  viewsValid: number;
  viewsTotal: number;
  failedIds: readonly string[];
};

export type Pooled = {
  runs: number;
  passed: number;
  total: number;
  byCategory: Map<string, { passed: number; total: number }>;
  ungrounded: number;
  checked: number;
  viewsValid: number;
  viewsTotal: number;
  /** Runs where boundary was below 100%. */
  boundaryMissRuns: number[];
  /** Runs with an ungrounded number. */
  ungroundedRuns: number[];
  /** Question ids failed in at least ceil(runs/2) runs (two of three), with their counts. */
  repeatFailures: { id: string; runs: number }[];
};

/** Sums the runs: the pooled rate is the statistic, with the per-run strict bars kept per run. */
export function pool(runs: readonly RunTally[]): Pooled {
  const out: Pooled = { runs: runs.length, passed: 0, total: 0, byCategory: new Map(), ungrounded: 0, checked: 0, viewsValid: 0, viewsTotal: 0, boundaryMissRuns: [], ungroundedRuns: [], repeatFailures: [] };
  const failCount = new Map<string, number>();
  runs.forEach((run, i) => {
    out.passed += run.passed;
    out.total += run.total;
    out.ungrounded += run.ungrounded;
    out.checked += run.checked;
    out.viewsValid += run.viewsValid;
    out.viewsTotal += run.viewsTotal;
    if (run.ungrounded > 0) out.ungroundedRuns.push(i + 1);
    for (const [c, row] of run.byCategory) {
      const acc = out.byCategory.get(c) ?? { passed: 0, total: 0 };
      acc.passed += row.passed;
      acc.total += row.total;
      out.byCategory.set(c, acc);
      if (c === "boundary" && row.passed < row.total) out.boundaryMissRuns.push(i + 1);
    }
    for (const id of run.failedIds) failCount.set(id, (failCount.get(id) ?? 0) + 1);
  });
  const half = Math.ceil(runs.length / 2);
  out.repeatFailures = [...failCount].filter(([, n]) => runs.length > 1 && n >= half).map(([id, n]) => ({ id, runs: n })).sort((a, b) => b.runs - a.runs || a.id.localeCompare(b.id));
  return out;
}

/**
 * The pooled bars: overall at least `overall` pooled, every non-boundary category at least `category` pooled (when a
 * category bar applies: the golden set, not the holdout), boundary 100% in every run, ungrounded 0 in every run, every
 * view valid. Returns the reasons it is not met; empty means met.
 */
export function pooledBarsUnmet(p: Pooled, bars: { overall: number; category: number | null }): string[] {
  const reasons: string[] = [];
  if (pct(p.passed, p.total) < bars.overall) reasons.push(`overall ${pct(p.passed, p.total)}% < ${bars.overall}%`);
  if (bars.category !== null) {
    for (const [c, row] of p.byCategory) if (c !== "boundary" && pct(row.passed, row.total) < bars.category) reasons.push(`category ${c} ${pct(row.passed, row.total)}% < ${bars.category}%`);
  }
  if (p.boundaryMissRuns.length) reasons.push(`boundary below 100% in run ${p.boundaryMissRuns.join(", ")}`);
  if (p.ungroundedRuns.length) reasons.push(`ungrounded number in run ${p.ungroundedRuns.join(", ")}`);
  if (p.viewsValid !== p.viewsTotal) reasons.push(`views valid ${p.viewsValid}/${p.viewsTotal}`);
  return reasons;
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
  // `mustSay` items are judged by eval/judge.ts (async, in run.ts); only the deterministic checks live here.
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
