import { describe, expect, test } from "bun:test";

import { checkQuestion, extractNumbers, feedCited, feedStateDisclosed, mustCiteOk, numbersTrace } from "@/eval/check";
import { CATEGORIES, GOLDEN_SETS, goldenFromFile, type Golden } from "@/eval/golden";
import type { Evidence } from "@/server/agent/runtime/registry";
import type { AgentStreamEvent } from "@/shared/agent/events";
import type { FeedState } from "@/shared/feed-state";

/**
 * gates/leaf-AG1.md G4: the eval harness loads the carp question file as its golden set (all 69, ten
 * categories, `context` applied) and its numbers-trace check rejects an invented number while accepting a
 * unit-converted one.
 */

const TOOL = JSON.stringify({
  rows: [
    { site: "KRZL1", source: "usgs", param: "stage", unit: "ft", latest: { value: 1.65, metres: 0.5, at: "2026-10-01T06:00:00Z" } },
    { site: "MLUL1", source: "nwps", flow: { value: 8.11, unit: "kcfs", cfs: 8110 } },
    { site: "MLUL1", source: "usgs", param: "discharge", unit: "cfs", latest: { value: 1430 } },
    { temperatureC: 31.11, windMs: 4.47 },
  ],
  ageHours: 15.5,
});

describe("eval trace", () => {
  test("eval trace: the golden set is the question file: 69 questions, ten categories, tools, mustCite, modes and context", () => {
    const carp = GOLDEN_SETS.carp!;
    expect(carp).toHaveLength(69);
    const byCategory = new Map<string, number>();
    for (const g of carp) byCategory.set(g.category!, (byCategory.get(g.category!) ?? 0) + 1);
    expect([...byCategory.keys()].sort()).toEqual([...CATEGORIES].sort());
    for (const c of CATEGORIES) expect(byCategory.get(c)!).toBeGreaterThanOrEqual(6);
    const review = carp.find((g) => g.id === "carp-lookup-review-today")!;
    expect(review.expect.tools).toEqual(["site_status", "set_view"]);
    expect(review.mustCite).toEqual(["feed:usgs", "feed:nwps", "feed:nws"]);
    expect(review.expect.view).toBe(true);
    expect(review.mustSay).toEqual(["Names the sites that need operational review", "Gives the reason a site needs review: the rule, trigger or threshold behind the flag"]);
    expect(review.expect.forbid![0]!.test("carp are abundant there")).toBe(true);
    const explain = carp.find((g) => g.id === "carp-explain-start-review")!;
    expect(explain.context).toEqual({ selectedSite: "MCGL1" });
    expect(carp.filter((g) => g.mode === "refuse").map((g) => g.expect.tools)).toEqual(carp.filter((g) => g.mode === "refuse").map(() => []));
    expect(carp.filter((g) => g.quality)).toHaveLength(7);
    expect(goldenFromFile({ app: "x", questions: [] })).toEqual([]);
  });

  test("eval trace: numbers in the answer are read without ids, dates, times and years", () => {
    const text = "At 2026-10-01T06:00:00Z (01:00 CDT, 1:00 am) KRZL1 read 1.65 ft (USGS 07381500), 15.5 h old; in 2026 the 3rd check at 10:32 found 8,110 cfs.";
    expect(extractNumbers(text).map((n) => n.raw)).toEqual(["1.65", "15.5", "8,110"]);
    // A whole number's trailing zeros are a rounding: 8110 matches 8105..8115, "21,200" matches 21187.
    expect(extractNumbers("8.11 kcfs = 8110 cfs")[1]).toEqual({ value: 8110, decimals: -1, raw: "8110" });
    expect(numbersTrace("about 21,200 cfs", [JSON.stringify({ mean24h: 21187 })]).ungrounded).toEqual([]);
    expect(numbersTrace("about 21,300 cfs", [JSON.stringify({ mean24h: 21187 })]).ungrounded.map((n) => n.raw)).toEqual(["21,300"]);
  });

  test("eval trace: an invented number is rejected; a unit-converted one is accepted", () => {
    const invented = numbersTrace("Krotz Springs reads 1.65 ft at USGS; the flow at Monroe is 12.3 kcfs.", [TOOL]);
    expect(invented.checked).toBe(2);
    expect(invented.ungrounded.map((n) => n.raw)).toEqual(["12.3"]);
    const converted = numbersTrace("Krotz Springs reads 0.50 m (1.65 ft); Monroe NWPS flow is 8,110 cfs and USGS 1.43 kcfs; the air is 88 °F with wind near 10 mph; the forecast is 0.65 days old.", [TOOL]);
    expect(converted.ungrounded).toEqual([]);
    expect(converted.checked).toBe(6);
    // Exact numbers at the answer's precision: 1.6 and 1.7 ft are roundings of 1.65, 1.8 is not.
    expect(numbersTrace("about 1.6 ft", [TOOL]).ungrounded).toEqual([]);
    expect(numbersTrace("about 1.7 ft", [TOOL]).ungrounded).toEqual([]);
    expect(numbersTrace("about 1.8 ft", [TOOL]).ungrounded.map((n) => n.raw)).toEqual(["1.8"]);
    // Small counts, days of the month and numbers from the question are not measurements.
    expect(numbersTrace("3 of 8 sites over the last 24 hours, 2 days ago", [TOOL], "over the last 24 hours").checked).toBe(0);
    expect(numbersTrace("the 72-hour window", [TOOL]).ungrounded.map((n) => n.raw)).toEqual(["72"]);
    expect(numbersTrace("the 72-hour window", [TOOL], "last three days (72 hours)").ungrounded).toEqual([]);
  });

  test("eval trace: feed-state disclosure needs freshness words and the state of every degraded feed used", () => {
    const nominal: FeedState = { source: "usgs", mode: "poll", state: "nominal", newestObservedAt: null, lastFetchAt: null, lastFetchRunId: "1", lagSeconds: 0, note: null };
    const stale: FeedState = { ...nominal, source: "nwps", state: "stale" };
    const disabled: FeedState = { ...nominal, source: "nwws", state: "down", note: "disabled: pending" };
    expect(feedStateDisclosed("The stage is 1.65 ft as of 01:00 CDT.", [nominal])).toEqual({ ok: true, reasons: [] });
    expect(feedStateDisclosed("The stage is 1.65 ft, 1 h old.", [nominal]).ok).toBe(true);
    expect(feedStateDisclosed("The stage is 1.65 ft.", [nominal]).ok).toBe(false);
    expect(feedStateDisclosed("Issued yesterday; the forecast is fresh.", [stale]).reasons).toEqual(['feed nwps is stale in a result used, but the answer never says "stale"']);
    expect(feedStateDisclosed("The NWPS forecast is stale (40 h old).", [stale, disabled]).ok).toBe(true);
  });

  test("eval trace: mustCite feed:x needs a cited record from that feed (prefix match for nws), kind:x a citation of that kind", () => {
    const by = new Map<string, Evidence>([
      ["reading:1", { id: "reading:1", kind: "reading", label: "r", feed: "usgs" }],
      ["fetch:9", { id: "fetch:9", kind: "fetch", label: "f", feed: "nws-alerts" }],
      ["forecast:MCGL1:1", { id: "forecast:MCGL1:1", kind: "forecast", label: "f", feed: "nwps" }],
    ]);
    expect(feedCited(["fetch:9"], by, "nws")).toBe(true);
    expect(feedCited(["reading:1"], by, "nws")).toBe(false);
    expect(mustCiteOk(["reading:1", "fetch:9"], by, ["feed:usgs", "feed:nws", "kind:reading"])).toEqual([]);
    expect(mustCiteOk(["reading:1"], by, ["feed:nwps", "kind:forecast"])).toEqual(["no citation from feed nwps", "no forecast: citation"]);
  });

  test("eval trace: checkQuestion applies tools, citations, forbid, numbers and feed state to a stream (mustSay is the judge's)", () => {
    const golden: Golden = {
      id: "q",
      question: "What is the river stage at Krotz Springs right now?",
      quality: false,
      category: "lookup",
      mode: "answer",
      mustCite: ["feed:usgs", "kind:reading"],
      mustSay: ["Gives a stage or height value in feet"],
      expect: { tools: ["river_readings"], forbid: [/safe/], minCitations: 1, cites: { reading: 1 }, groundedNumbers: true, feedState: true },
    };
    const evidence: Evidence[] = [{ id: "reading:1", kind: "reading", label: "r", feed: "usgs" }];
    const stream = (content: string): AgentStreamEvent[] => [
      { type: "tool_start", toolCallId: "1", capabilityName: "river_readings" },
      { type: "tool_end", toolCallId: "1", capabilityName: "river_readings", ok: true, data: { count: 1, evidence, feeds: [] } },
      { type: "citation", id: "reading:1", kind: "reading", label: "r" },
      { type: "done", content },
    ];
    const captures = [{ name: "river_readings", text: TOOL, feeds: [] }];
    const good = checkQuestion(golden, stream("Krotz Springs reads 1.65 ft at USGS as of 01:00 CDT [e:reading:1]."), captures);
    expect(good.reasons).toEqual([]);
    expect(good.trace).toEqual({ checked: 1, ungrounded: [] });
    const bad = checkQuestion(golden, stream("Krotz Springs reads 2.95 ft and it is safe [e:reading:1] [e:reading:2]."), captures);
    expect(bad.reasons).toEqual(expect.arrayContaining(["final text cites unreturned id reading:2", "forbidden phrase /safe/", "ungrounded numbers: 2.95", expect.stringContaining("does not say how fresh")]));
    const refusal: Golden = { ...golden, mode: "refuse", mustCite: [], mustSay: ["Says it cannot estimate abundance"], expect: { tools: [], minCitations: 0, groundedNumbers: true, feedState: false } };
    expect(checkQuestion(refusal, [{ type: "done", content: "I cannot estimate carp abundance." }], []).reasons).toEqual([]);
    expect(checkQuestion(refusal, stream("I cannot."), captures).reasons).toEqual(["refusal called tools: river_readings"]);
  });
});
