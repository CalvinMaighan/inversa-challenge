import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_NOW, startStub, type Stub } from "@/eval/stub-server";
import { checkViews } from "@/eval/views";
import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { buildAgentRegistry, NEARBY_DEG } from "@/server/agent/tools/capabilities";
import { extentOf, MAX_SERIES_POINTS, seriesPoints, viewOf, type ToolViewData } from "@/server/agent/tools/views";
import { isToolResultData, type CellsView, type SeriesView, type TableView } from "@/shared/agent/results";

/**
 * C17: every data tool's `tool_end.data` carries a `ToolResultData`. These run the real tools against the
 * fixture GraphQL stub (no LLM) and check the view each one builds.
 */

let stub: Stub;
let dataDir: string;
const NOW = new Date(FIXTURE_NOW);
const ctx: CapabilityContext = { now: NOW, emit: () => {} };
const registry = buildAgentRegistry();
const HOMESTEAD = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };
const SHARK_VALLEY = { west: -80.85, south: 25.67, east: -80.68, north: 25.84 };

beforeAll(() => {
  stub = startStub();
  dataDir = mkdtempSync(join(tmpdir(), "inversa-views-test-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
});

afterAll(() => {
  stub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function run(name: string, input: unknown, at: CapabilityContext = ctx): Promise<{ out: CapabilityOutput; view: ToolViewData }> {
  const result = await registry.execute(name, input, at);
  if (!result.ok) throw new Error(result.error);
  const view = viewOf(result.output);
  if (!view) throw new Error(`${name} attached no view`);
  // What reaches the client: the bridge spreads the view into tool_end.data next to count/evidence/feeds.
  const data = JSON.parse(JSON.stringify({ count: result.output.count, evidence: result.output.evidence, ...view })) as unknown;
  expect(isToolResultData(data)).toBe(true);
  return { out: result.output, view };
}

const modelText = (out: CapabilityOutput) => JSON.stringify(out.data);

describe("C17 views per tool", () => {
  test("C17 view: sightings → table with sighting ids, dup/conflict flags, highlight and bbox", async () => {
    const { out, view } = await run("sightings", { bbox: HOMESTEAD, species: ["tegu"] });
    const table = view.result as TableView;
    expect(table.view).toBe("table");
    expect(table.columns.map((c) => c.key)).toEqual(["time", "species", "quality", "source", "lat", "lon", "dup", "conflict", "late"]);
    expect(table.columns.find((c) => c.key === "time")?.kind).toBe("time");
    expect(table.rows.map((r) => r.evidenceId)).toEqual(["sighting:2001", "sighting:2002", "sighting:2003"]);
    expect(table.rows.find((r) => r.evidenceId === "sighting:2002")?.conflict).toBe("conflict");
    expect(table.rows[0]).toMatchObject({ species: "Argentine black and white tegu", quality: "research", source: "inat", lat: 25.501, lon: -80.452 });
    expect(view.highlight).toEqual(["sighting:2001", "sighting:2002", "sighting:2003"]);
    expect(view.bbox).toEqual(HOMESTEAD);
    expect(table.title).toBe("Argentine black and white tegu sightings · last 7 days");
    // The model reads the compact summary; the column schema and view stay out of its text.
    expect(modelText(out)).not.toContain('"columns"');

    const pythons = await run("sightings", { bbox: SHARK_VALLEY });
    const rows = (pythons.view.result as TableView).rows;
    expect(rows.find((r) => r.evidenceId === "sighting:1002")?.dup).toBe("sighting:1001");
    // The NAS copy of 1003 reached the API 2.2 days after the animal was seen; the GBIF copy of 1001 within hours.
    expect(rows.find((r) => r.evidenceId === "sighting:1004")?.late).toBe("2.2 days after");
    expect(rows.find((r) => r.evidenceId === "sighting:1002")?.late).toBeNull();
    // Canonical records are bracketed before their duplicates.
    expect(pythons.view.highlight!.slice(0, 2)).toEqual(["sighting:1001", "sighting:1003"]);
  });

  test("C17 view: sightings with no window widen to 30 days when the last 7 are empty, in one GraphQL call", async () => {
    const later: CapabilityContext = { now: new Date("2026-01-24T03:00:00Z"), emit: () => {} };
    stub.requests.length = 0;
    const { out, view } = await run("sightings", { bbox: HOMESTEAD, species: ["iguana"] }, later);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.variables).toMatchObject({ from: "2025-12-25T03:00:00.000Z", to: "2026-01-24T03:00:00.000Z" });
    expect(out.data.widened).toContain("widened");
    expect((view.result as TableView).rows.map((r) => r.evidenceId)).toEqual(["sighting:3001", "sighting:3002"]);
    expect((view.result as TableView).title).toContain("last 30 days");
    // A window the model spelled out but that still ends now ("recent", as models tend to fill every field) widens too.
    const spelled = await run("sightings", { bbox: HOMESTEAD, species: ["iguana"], from: "2026-01-17T03:00:00Z", to: "2026-01-24T03:00:00Z", hours: 168 }, later);
    expect((spelled.view.result as TableView).rows).toHaveLength(2);
    expect(String(spelled.out.data.widened)).toContain("7 days asked for");
    // Empty strings for the optional times (a common model habit) mean "not given", not a failed call.
    const blank = await run("sightings", { bbox: HOMESTEAD, species: ["iguana"], from: "", to: "", hours: 168 }, later);
    expect((blank.view.result as TableView).rows).toHaveLength(2);
    // A historical window is never widened…
    const past = await run("sightings", { bbox: HOMESTEAD, species: ["iguana"], from: "2026-01-18T00:00:00Z", to: "2026-01-20T00:00:00Z" }, later);
    expect((past.view.result as TableView).rows).toHaveLength(0);
    expect(past.out.data.widened).toBeUndefined();
    // …but the model hears that older records exist, so it can ask again.
    expect(past.out.data.olderInLast30Days).toBe(2);
    expect(String(past.out.data.hint)).toContain("hours: 720");
    expect((past.view.result as TableView).title).toBe("Green iguana sightings · 01-18 to 01-20");
  });

  test("C17 view: conditions → a series per parameter with gaps as nulls, plus a latest-values table", async () => {
    const { out, view } = await run("conditions", { bbox: { west: -80.9, south: 25.2, east: -80.3, north: 25.8 }, params: ["stage_m", "air_c"] });
    const first = view.result as SeriesView;
    expect(first.view).toBe("series");
    expect(first.unit).toBe("m");
    expect(first.title).toBe("Water level (stage)");
    const np205 = first.series.find((line) => line.label.startsWith("USGS NP-205"))!;
    expect(np205.evidenceId).toBe("reading:41:stage_m:1768442400000:measured");
    // 19 hourly samples + the latest; the SUSPECT sample is null and the 4-hour outage gets a null break.
    const nulls = np205.points.filter(([, v]) => v === null);
    expect(nulls).toHaveLength(2);
    expect(np205.points.at(-1)).toEqual([Date.parse("2026-01-15T02:00:00Z"), 1.12]);
    expect(first.series.find((line) => line.label.startsWith("USGS S-18-C"))!.points).toHaveLength(24);
    const more = view.more ?? [];
    expect(more.map((v) => v.view)).toEqual(["series", "table"]);
    const air = more[0] as SeriesView;
    expect(air.unit).toBe("°C");
    expect(air.series[0]!.label).toBe("KHST Homestead ARB");
    const latest = more[1] as TableView;
    expect(latest.rows.every((row) => row.evidenceId.startsWith("reading:"))).toBe(true);
    expect(latest.rows.find((row) => row.evidenceId === "reading:41:stage_m:1768442400000:measured")).toMatchObject({
      station: "USGS NP-205 Shark River Slough",
      value: 1.12,
      unit: "m",
      lat: 25.69,
      lon: -80.8,
    });
    // One bracket per station.
    expect(new Set(view.highlight).size).toBe(view.highlight!.length);
    expect(view.highlight).toContain("reading:42:stage_m:1768442400000:measured");
    // The model still gets one latest row per series, not the history.
    expect((out.data.rows as unknown[]).length).toBe(latest.rows.length);
    expect(modelText(out)).not.toContain('"points"');
  });

  test("C17 view: conditions fall back to the nearest stations when none is inside the area", async () => {
    stub.requests.length = 0;
    const { out, view } = await run("conditions", { bbox: HOMESTEAD, params: ["stage_m"] });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.variables.bbox).toEqual({
      west: HOMESTEAD.west - NEARBY_DEG,
      south: HOMESTEAD.south - NEARBY_DEG,
      east: HOMESTEAD.east + NEARBY_DEG,
      north: HOMESTEAD.north + NEARBY_DEG,
    });
    expect(String(out.data.scope)).toContain("nearest");
    const series = view.result as SeriesView;
    expect(series.series.map((line) => line.label).sort()).toEqual(["USGS NP-205 Shark River Slough", "USGS S-18-C C-111 near Florida City"]);
    expect(series.title).toContain("nearest stations");
    expect(view.bbox).toEqual(stub.requests[0]!.variables.bbox as typeof HOMESTEAD);
    // Inside rows win when there are any: Shark Valley has its own gauge.
    const inside = await run("conditions", { bbox: SHARK_VALLEY, params: ["stage_m"] });
    expect(inside.out.data.scope).toBeUndefined();
    expect((inside.view.result as SeriesView).series.map((line) => line.label)).toEqual(["USGS NP-205 Shark River Slough"]);
  });

  test("C17 view: alerts → table with alert ids", async () => {
    const { view } = await run("alerts", { bbox: { west: -80.6, south: 25.3, east: -80.3, north: 25.6 } });
    const table = view.result as TableView;
    expect(table.view).toBe("table");
    expect(table.rows.map((r) => r.evidenceId)).toEqual(["alert:5001", "alert:5002"]);
    expect(table.rows[0]).toMatchObject({ event: "Cold Weather Advisory", severity: "moderate", expires: "2026-01-15T14:00:00Z" });
    expect(view.highlight).toEqual(["alert:5001", "alert:5002"]);
  });

  test("C17 view: hotspots → ranked cells with hotspot ids, highlight, and a bbox around the cells", async () => {
    const { view } = await run("hotspots", { species: "python", top: 3 });
    const cells = view.result as CellsView;
    expect(cells.view).toBe("cells");
    expect(cells.species).toBe("python");
    expect(cells.cells.map((c) => c.evidenceId)).toEqual([
      "hotspot:python:243:145:1768446000000",
      "hotspot:python:244:147:1768446000000",
      "hotspot:python:228:84:1768446000000",
    ]);
    expect(cells.cells.map((c) => c.score)).toEqual([0.82, 0.74, 0.51]);
    expect(view.highlight).toEqual(cells.cells.map((c) => c.evidenceId));
    expect(view.bbox).toEqual({ west: -80.965, south: 25.095, east: -80.705, north: 25.825 });
  });

  test("C17 view: explain_cell → explain with term bars", async () => {
    const { view } = await run("explain_cell", { species: "python", cell: "243:145" });
    expect(view.result).toMatchObject({ view: "explain", evidenceId: "hotspot:python:243:145:1768446000000", score: expect.any(Number) });
    const terms = (view.result as { terms: { name: string; rationale: string }[] }).terms;
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.every((t) => t.rationale.length > 0)).toBe(true);
    expect(view.highlight).toEqual(["hotspot:python:243:145:1768446000000"]);
    expect(view.bbox!.west).toBeLessThan(-80.765);
    expect(view.bbox!.east).toBeGreaterThan(-80.765);
  });

  test("C17 view: backtest → per-day bars against the baseline", async () => {
    const { view } = await run("backtest", { species: "python", days: 7 });
    expect(view.result).toMatchObject({ view: "backtest", evidenceId: "backtest:python:7", hitRate: 0.31, baseline: 0.1 });
    expect((view.result as { perDay: unknown[] }).perDay).toHaveLength(7);
    expect(view.highlight).toBeUndefined();
  });

  test("C17 view: feed_state → feed chips, worst first", async () => {
    const { view } = await run("feed_state", {});
    const feeds = (view.result as { view: string; feeds: { source: string; state: string }[] });
    expect(feeds.view).toBe("feeds");
    expect(feeds.feeds).toHaveLength(10);
    expect(feeds.feeds[0]!.state).toBe("down");
    const rank = { down: 0, stale: 1, lagging: 2, nominal: 3 } as Record<string, number>;
    for (let i = 1; i < feeds.feeds.length; i++) expect(rank[feeds.feeds[i]!.state]!).toBeGreaterThanOrEqual(rank[feeds.feeds[i - 1]!.state]!);
  });

  test("geocode and set_view attach no view", async () => {
    const place = await registry.execute("geocode", { place: "Flamingo" }, ctx);
    expect(place.ok && viewOf(place.output)).toBeFalsy();
  });
});

describe("series points and extents", () => {
  test("a sampling gap past 3 median steps becomes a null break; flagged values stay null", () => {
    const h = 3_600_000;
    const pts = seriesPoints([
      { t: 6 * h, value: 1 },
      { t: 0, value: 1 },
      { t: h, value: null },
      { t: 2 * h, value: 2 },
      { t: 7 * h, value: 3 },
    ]);
    // Steps 1, 1, 4, 1 h: the median is 1 h, so the 4 h jump breaks the line; 3 h would not.
    expect(pts).toEqual([
      [0, 1],
      [h, null],
      [2 * h, 2],
      [4 * h, null],
      [6 * h, 1],
      [7 * h, 3],
    ]);
    expect(seriesPoints([{ t: 0, value: 1 }, { t: h, value: 1 }, { t: 4 * h, value: 1 }, { t: 5 * h, value: 1 }]).some(([, v]) => v === null)).toBe(false);
  });

  test("long lines are thinned to the cap, keeping both ends and every gap", () => {
    const samples = Array.from({ length: 5_000 }, (_, i) => ({ t: i * 60_000, value: i === 2_500 ? null : i }));
    const pts = seriesPoints(samples);
    expect(pts.length).toBeLessThanOrEqual(MAX_SERIES_POINTS + 2);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([4_999 * 60_000, 4_999]);
    expect(pts.some(([, v]) => v === null)).toBe(true);
  });

  test("extent pads points and never frames less than 0.1°", () => {
    expect(extentOf([])).toBeNull();
    const one = extentOf([{ lat: 25.5, lon: -80.4 }], 0)!;
    expect(one.east - one.west).toBeCloseTo(0.1, 6);
    expect(one.north - one.south).toBeCloseTo(0.1, 6);
  });
});

describe("eval view check", () => {
  test("counts successful data tool_ends and flags any without a valid ToolResultData view", async () => {
    const good = await registry.execute("alerts", {}, ctx);
    if (!good.ok) throw new Error(good.error);
    const data = { count: good.output.count, evidence: good.output.evidence, feeds: good.output.feeds, ...viewOf(good.output) };
    const check = checkViews([
      { type: "tool_end", toolCallId: "1", capabilityName: "alerts", ok: true, data },
      { type: "tool_end", toolCallId: "2", capabilityName: "geocode", ok: true, data: { name: "x" } },
      { type: "tool_end", toolCallId: "3", capabilityName: "sightings", ok: false, error: "boom" },
      { type: "tool_end", toolCallId: "4", capabilityName: "conditions", ok: true, data: { count: 0, evidence: [], feeds: [] } },
      { type: "tool_end", toolCallId: "5", capabilityName: "hotspots", ok: true, data: { result: { view: "cells" }, more: [{ view: "pie" }] } },
    ]);
    expect(check.total).toBe(3);
    expect(check.valid).toBe(1);
    expect(check.reasons).toEqual([
      "conditions tool_end.data is not a ToolResultData with a view",
      "hotspots tool_end.data is not a ToolResultData with a view",
    ]);
  });
});
