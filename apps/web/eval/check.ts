/**
 * Per-question checks for the live eval (docs/grading/rubric.md "Agent and eval"): the golden's `pass`
 * criteria (phrases, forbid patterns, mode), required tools, citations by kind and by feed (`mustCite`),
 * the numbers trace (every number in the answer appears in some tool output, unit conversions allowed) and
 * the feed-state disclosure. Pure over the event stream plus the captured model-facing tool outputs.
 */

import type { Golden } from "./golden";

import { FRESHNESS_WORDS } from "@/server/agent/answer-check";
import { citedIds } from "@/server/agent/cordis/citations";
import type { Evidence } from "@/server/agent/runtime/registry";
import type { AgentStreamEvent } from "@/shared/agent/events";
import type { FeedState } from "@/shared/feed-state";

// ---------------------------------------------------------------- numbers trace

/** Text that is not a measurement: citation markers, dates and times, ids, years. */
const NOT_A_VALUE = [
  /\[e:[^\]\n]+\]/g,
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|z|utc|cdt|cst|est|edt)?\b/gi,
  /\b\d{1,2}\s?(?:am|pm)\b/gi,
  /\b[A-Z]{4}\d\b/g,
  /\b\d{8}\b/g,
  /\b(?:19|20)\d{2}\b/g,
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
  // Run and record ids such as "c-usgs-4412", "NWS-LIX-FA-W-0091" (a value like "USGS 1.43 kcfs" is kept).
  /\b[a-z]*-?(?:usgs|nws|nwps|nwsa|nwsf|iem|web)-[a-z-]*\d+\b/gi,
];

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

/** Numbers in free text, after stripping ids, dates and times. Each with its decimal places. */
export function extractNumbers(text: string): { value: number; decimals: number; raw: string }[] {
  let clean = text;
  for (const re of NOT_A_VALUE) clean = clean.replace(re, " ");
  const out: { value: number; decimals: number; raw: string }[] = [];
  for (const m of clean.matchAll(NUMBER)) {
    const raw = m[0];
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const dot = raw.indexOf(".");
    // Trailing zeros of a whole number are a rounding ("21,200" for 21187), so they count as negative decimals.
    const zeros = dot === -1 ? (/0+$/.exec(raw.replace(/,/g, ""))?.[0].length ?? 0) : 0;
    out.push({ value, decimals: dot === -1 ? (Math.abs(value) >= 1000 ? -Math.min(zeros, 2) : 0) : raw.length - dot - 1, raw });
  }
  return out;
}

/** Numbers in a tool's model-facing JSON (all numeric tokens, including inside strings), minus dates, times and ids. */
export function toolNumbers(texts: readonly string[]): number[] {
  const out: number[] = [];
  for (const text of texts) {
    let clean = text;
    for (const re of NOT_A_VALUE) clean = clean.replace(re, " ");
    for (const m of clean.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)) out.push(Number(m[0]));
  }
  return out.filter(Number.isFinite);
}

/** Small counts, hours of the day and days of the month are not measurements. */
const SMALL_INT_MAX = 31;

/** Unit conversions the model may apply: each maps a tool value to an answer value. */
const CONVERSIONS: ((b: number) => number)[] = [
  (b) => b,
  (b) => b / 0.3048, // m -> ft
  (b) => b * 0.3048, // ft -> m
  (b) => b * 1000, // kcfs -> cfs
  (b) => b / 1000, // cfs -> kcfs
  (b) => (b * 9) / 5 + 32, // C -> F
  (b) => ((b - 32) * 5) / 9, // F -> C
  (b) => b / 0.44704, // m/s -> mph
  (b) => b * 0.44704, // mph -> m/s
  (b) => b / 24, // hours -> days
  (b) => b * 24, // days -> hours
  (b) => b / 60, // minutes -> hours
  (b) => b * 60, // hours -> minutes
  (b) => b / 3600, // seconds -> hours
  (b) => b * 3.28084, // metres -> feet (rounded factor)
  (b) => b / 3.28084,
];

function matches(a: { value: number; decimals: number }, b: number): boolean {
  const tol = 0.5 * 10 ** -a.decimals + 1e-9;
  for (const convert of CONVERSIONS) {
    const c = convert(b);
    if (!Number.isFinite(c)) continue;
    if (Math.abs(a.value - c) <= tol) return true;
    // A converted value the model rounded further (1430 cfs -> "1.4 kcfs").
    if (convert !== CONVERSIONS[0] && Math.abs(a.value - c) <= Math.max(tol, Math.abs(c) * 0.012)) return true;
  }
  return false;
}

export type NumbersTrace = { checked: number; ungrounded: { value: number; raw: string }[] };

/**
 * Every number in `answer` must appear in some tool output (exactly at the answer's precision, or through a
 * unit conversion), or in the question itself. Small integers and years are skipped.
 */
export function numbersTrace(answer: string, toolTexts: readonly string[], question = ""): NumbersTrace {
  const pool = toolNumbers(toolTexts);
  const asked = new Set(extractNumbers(question).map((n) => n.value));
  const out: NumbersTrace = { checked: 0, ungrounded: [] };
  for (const n of extractNumbers(answer)) {
    const isSmallInt = n.decimals === 0 && Number.isInteger(n.value) && Math.abs(n.value) <= SMALL_INT_MAX;
    if (isSmallInt || asked.has(n.value)) continue;
    out.checked += 1;
    if (!pool.some((b) => matches(n, b))) out.ungrounded.push({ value: n.value, raw: n.raw });
  }
  return out;
}

// ---------------------------------------------------------------- feed-state disclosure

/**
 * The answer says how fresh its data is: freshness vocabulary or an age, and the state word of every
 * non-nominal feed a used tool result carried.
 */
export function feedStateDisclosed(answer: string, feedsUsed: readonly FeedState[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!FRESHNESS_WORDS.test(answer)) reasons.push("answer does not say how fresh its data is (no age, 'as of', issued/updated/fetched, stale/lagging/down)");
  const degraded = [...new Map(feedsUsed.filter((f) => f.state !== "nominal").map((f) => [f.source, f])).values()];
  for (const feed of degraded) {
    // A disabled push feed (note "disabled:") is configuration, not a data problem; it need not be narrated.
    if (feed.state === "down" && feed.note?.startsWith("disabled:")) continue;
    if (!new RegExp(`\\b${feed.state}\\b`, "i").test(answer)) reasons.push(`feed ${feed.source} is ${feed.state} in a result used, but the answer never says "${feed.state}"`);
  }
  return { ok: reasons.length === 0, reasons };
}

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

// ---------------------------------------------------------------- the whole check

export type ToolCapture = { name: string; text: string; feeds: FeedState[] };

export type QuestionCheck = { reasons: string[]; tools: string[]; cited: string[]; trace: NumbersTrace };

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
  // Typographic apostrophes and quotes read as their ASCII forms, as the pass regexes are written.
  const content = (done[0]?.type === "done" ? done[0].content : "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
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
