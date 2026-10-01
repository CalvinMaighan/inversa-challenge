/**
 * Generic answer check, run on every final answer before it streams (docs/grading/rubric.md "agent-grounding").
 * It knows nothing about the benchmark's questions: it checks that every number in the answer traces to a
 * tool output, that an answer built on data feeds says how fresh they are and names every degraded feed's
 * state, that provenance is complete (every feed source_info returned is cited; a record fetched through the
 * evidence tool is reported with its licence), and that a question in a boundary category (abundance, catch,
 * legal access, trip safety, causal claims about the animals) gets a stated limit. When something is missing the model is asked for one
 * revision. The eval harness applies the same functions afterwards (eval/check.ts). Pure.
 */

import type { CapabilityRegistry } from "@/server/agent/runtime/registry";
import type { AppConfig } from "@/shared/apps";
import type { FeedState } from "@/shared/feed-state";

/** A successful tool output as the model saw it, with its feed envelopes. */
export type ToolCapture = { name: string; text: string; feeds: FeedState[] };

/** Wraps a registry so every successful output is captured for the numbers trace and the feed-state check. */
export function capturing(registry: CapabilityRegistry, into: ToolCapture[]): CapabilityRegistry {
  const execute = registry.execute.bind(registry);
  registry.execute = async (name, rawInput, ctx) => {
    const result = await execute(name, rawInput, ctx);
    if (result.ok) into.push({ name, text: JSON.stringify(result.output.data), feeds: result.output.feeds });
    return result;
  };
  return registry;
}

/** Typographic quotes read as their ASCII forms and markdown emphasis is dropped ("do **not** confirm" reads "do not confirm"), as the criteria are written. */
export const plainQuotes = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\*{1,2}(?=\S)|(?<=\S)\*{1,2}|__/g, "");

/** Freshness vocabulary or an age: how an answer says how fresh its data is (rubric "feed-state disclosure"). */
export const FRESHNESS_WORDS =
  /\b(stale|lagging|down|fresh|nominal|current|up[- ]to[- ]date|late|live|real[- ]time)\b|\d+(\.\d+)?\s?(h|hr|hrs|hours?|min|mins|minutes?|days?)\s(old|ago)|\bas of\b|\b(last )?(updated|fetched|checked|issued|captured|polled|retrieved|ingested)\b/i;

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

// ---------------------------------------------------------------- boundary

/** A stated limit: the answer says in words that something cannot be judged from this data. */
export const LIMIT_WORDS = /\b(cannot|can't|can ?not|unable to|do not|don't|does not|doesn't|is not|isn't|no data|not something|no way to)\b/i;

/**
 * Questions a conditions app must not answer as asked: how many animals, how many will be caught, whether
 * access is legal, whether a trip is safe, whether the water moves the animals. Built from the app's own
 * boundary note, so an app without one has no such category.
 */
export function boundaryCategory(app: AppConfig, question: string): string | null {
  if (!app.copy.boundaryNote) return null;
  const q = question.toLowerCase();
  const fish = /\b(carp|fish|catch|harvest|caught)\b/;
  if (/\b(how many|number of|population|abundan|roughly|ballpark|estimate|expected catch)\b/.test(q) && fish.test(q)) return "abundance or catch";
  // A licence question about the data ("can we reuse the USGS data") is a sources question, not legal access.
  if (/\b(legal|legally|allowed|permit|permitted|regulation|regulations)\b/.test(q) && !/\b(licen[cs]e|reuse|attribution|data|feed|source)\b/.test(q)) return "legal access";
  if (/\b(safe|safety|safely|risky|dangerous)\b/.test(q) || /\b(can|should) we (take|go|launch|boat|get) /.test(q)) return "trip safety";
  if (/\b(make|makes|cause|causes|push|pushes|drive|drives|move|moves|gather|congregate|attract)\b/.test(q) && /\b(carp|fish)\b/.test(q)) return "causal claims about the fish";
  return null;
}

// ---------------------------------------------------------------- provenance

/** The `[e:source:<feed>]` markers of every feed a source_info result returned. */
function sourceRows(capture: ToolCapture): { feed: string; cite: string }[] {
  if (capture.name !== "source_info") return [];
  try {
    const rows = (JSON.parse(capture.text) as { rows?: { feed?: string; cite?: string }[] }).rows ?? [];
    return rows.flatMap((r) => (typeof r.feed === "string" && typeof r.cite === "string" ? [{ feed: r.feed, cite: r.cite }] : []));
  } catch {
    return [];
  }
}

/** The licence an evidence result carries, as written, up to its first clause break. */
function evidenceLicence(capture: ToolCapture): { id: string; licence: string } | null {
  if (capture.name !== "evidence") return null;
  try {
    const out = JSON.parse(capture.text) as { id?: string; licence?: string };
    if (typeof out.id !== "string" || typeof out.licence !== "string" || out.licence === "not recorded") return null;
    const clause = out.licence.split(/[;(]/)[0]!.trim();
    return clause ? { id: out.id, licence: clause } : null;
  } catch {
    return null;
  }
}

/**
 * Provenance is complete: every feed source_info returned is cited (a sources answer covers the whole result,
 * not the two feeds the model found most familiar), and a record fetched through the evidence tool is
 * reported with its licence as written (the point of the provenance call).
 */
export function provenanceProblems(content: string, captures: readonly ToolCapture[]): string[] {
  const problems: string[] = [];
  const text = content.toLowerCase();
  const missing = [...new Map(captures.flatMap(sourceRows).map((r) => [r.feed, r])).values()].filter((r) => !text.includes(r.cite.toLowerCase()));
  if (missing.length) problems.push(`source_info returned feeds the answer does not cite: ${missing.map((r) => `${r.feed} ${r.cite}`).join(", ")}. Name each feed and paste its marker`);
  for (const { id, licence } of captures.map(evidenceLicence).filter((x): x is { id: string; licence: string } => x !== null)) {
    if (!text.includes(licence.toLowerCase())) problems.push(`the record ${id} was fetched for its provenance: say its licence as written, '${licence}'`);
  }
  return problems;
}

// ---------------------------------------------------------------- the whole check

export type AnswerFacts = {
  app: AppConfig;
  question: string;
  content: string;
  captures: readonly ToolCapture[];
};

/** Problems with an answer, each as an instruction the model can act on; empty when the answer passes. */
export function answerProblems(facts: AnswerFacts): string[] {
  const content = plainQuotes(facts.content);
  const problems: string[] = [];
  const trace = numbersTrace(content, facts.captures.map((c) => c.text), facts.question);
  if (trace.ungrounded.length) {
    problems.push(`these numbers appear in no tool result: ${trace.ungrounded.map((n) => n.raw).join(", ")}. Quote values exactly as the tools give them (same precision, no arithmetic of your own) or leave them out`);
  }
  const feeds = facts.captures.flatMap((c) => c.feeds);
  if (feeds.length) problems.push(...feedStateDisclosed(content, feeds).reasons);
  problems.push(...provenanceProblems(content, facts.captures));
  const category = boundaryCategory(facts.app, facts.question);
  if (category && !LIMIT_WORDS.test(content)) {
    problems.push(`this question asks about ${category}, which the data cannot judge: say so in words (for example 'cannot'), keep the conditions you can show, and give no verdict or estimate`);
  }
  return problems;
}

/** The revision request for a failed answer: keep what was right, fix what the list names. */
export function revisionRequest(problems: readonly string[]): string {
  return [
    "Your answer does not yet meet the grounding rules. Revise it and reply with the complete corrected answer (not a diff), keeping every correct fact and every [e:…] marker that a tool returned:",
    ...problems.map((p) => `- ${p}`),
  ].join("\n");
}
