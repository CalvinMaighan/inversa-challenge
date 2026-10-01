/* eslint-disable @typescript-eslint/no-explicit-any -- tool rows are read loosely */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LIONFISH_FIXTURE_NOW } from "@/eval/stub-lionfish";
import { startStub, type Stub } from "@/eval/stub-server";
import { checkViews } from "@/eval/views";
import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { parseEvidenceId } from "@/server/agent/tools/evidence";
import { componentCellCentre, componentCellFor, findArea, isComponentApp } from "@/server/agent/tools/lionfish";
import { viewOf } from "@/server/agent/tools/views";
import type { AgentStreamEvent } from "@/shared/agent/events";
import type { SeriesView, TableView } from "@/shared/agent/results";
import { getApp } from "@/shared/apps";

/**
 * The lionfish tools (gates/leaf-AG2.md G1) against the fixture GraphQL stub: reef_heat, marine_forecast, the
 * component forms of hotspots, explain_cell and set_view, and the lionfish changes to sightings and geocode,
 * as spec/apps/questions/lionfish.json `newTools` and `toolChanges` specify them: every value labelled with its
 * unit, source and date; DHW and BAA always together; components separate, never a single percent.
 */

const LIONFISH = getApp("lionfish");
const NOW = new Date(LIONFISH_FIXTURE_NOW);
const DAY = 86_400_000;

let stub: Stub;
let dataDir: string;
const emitted: AgentStreamEvent[] = [];
const ctx: CapabilityContext = { app: LIONFISH, now: NOW, emit: (event) => emitted.push(event) };
const registry = buildAgentRegistry(LIONFISH);

beforeAll(() => {
  stub = startStub();
  dataDir = mkdtempSync(join(tmpdir(), "inversa-lionfish-tools-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
});

afterAll(() => {
  stub.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  stub.requests.length = 0;
  emitted.length = 0;
});

async function run(name: string, input: unknown): Promise<CapabilityOutput> {
  const result = await registry.execute(name, input, ctx);
  if (!result.ok) throw new Error(result.error);
  return result.output;
}

function expectEvidenceFormat(out: CapabilityOutput, feeds: string[]): void {
  expect(out.evidence.length).toBeGreaterThan(0);
  for (const row of out.evidence) {
    expect(parseEvidenceId(row.id)?.kind).toBe(row.kind);
    expect(row.id).not.toContain(",");
  }
  for (const feed of feeds) expect(out.evidence.some((row) => row.feed === feed)).toBe(true);
}

function expectView(name: string, out: CapabilityOutput): void {
  const event: AgentStreamEvent = { type: "tool_end", toolCallId: "t", capabilityName: name, ok: true, data: { count: out.count, evidence: out.evidence, feeds: out.feeds, ...viewOf(out) } };
  expect(checkViews([event])).toEqual({ valid: 1, total: 1, reasons: [] });
}

/** No output field may be a risk, probability, percent, abundance or safety verdict. */
function expectHonestKeys(out: CapabilityOutput): void {
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      keys.add(k.toLowerCase());
      walk(x);
    }
  };
  walk(out.data);
  for (const banned of ["risk", "riskpercent", "probability", "percent", "abundance", "population", "safe", "safety"]) expect([...keys]).not.toContain(banned);
}

describe("lionfish tool registry", () => {
  test("lionfish tool: the lionfish config registers exactly its allowlist, with the component forms and the two new tools", () => {
    expect(isComponentApp(LIONFISH)).toBe(true);
    expect(isComponentApp(getApp("python"))).toBe(false);
    const names = registry.list().map((cap) => cap.name);
    expect([...names].sort()).toEqual([...LIONFISH.agent.tools].sort());
    for (const tool of ["reef_heat", "marine_forecast", "hotspots", "explain_cell", "set_view", "source_info", "evidence", "team_board"]) expect(names).toContain(tool);
    expect(names).not.toContain("backtest");
    expect(registry.get("hotspots")!.description).toMatch(/four components/);
    expect(registry.get("hotspots")!.description).toMatch(/Never a single risk percent/);
  });

  test("lionfish tool: areas resolve by id, name, code and country words; places outside the four are not areas", () => {
    expect(findArea(LIONFISH, "belize")?.id).toBe("belize");
    expect(findArea(LIONFISH, "Mexican Caribbean")?.id).toBe("mx-caribbean");
    expect(findArea(LIONFISH, "the Florida Keys")?.id).toBe("fl-keys");
    expect(findArea(LIONFISH, "Colombia")?.id).toBe("co-caribbean");
    expect(findArea(LIONFISH, "fl")?.id).toBe("fl-keys");
    expect(findArea(LIONFISH, "Quintana Roo reefs")?.id).toBe("mx-caribbean");
    expect(findArea(LIONFISH, "Bahamas")).toBeNull();
    expect(findArea(LIONFISH, "all")).toBeNull();
    expect(componentCellFor(LIONFISH, 20.35, -87.03)).toBe("mx-caribbean:87:205");
    expect(componentCellCentre(LIONFISH, "mx-caribbean:87:205")).toEqual({ lat: 20.355, lon: -87.025 });
    expect(componentCellFor(LIONFISH, 25.0, -78.0)).toBeNull();
  });

  test("lionfish tool: geocode resolves the four areas and Caribbean reefs with their area, and refuses places outside", async () => {
    const belize = await run("geocode", { place: "Belize" });
    expect(belize.data).toMatchObject({ kind: "area", areaId: "belize", thin: true, bbox: { west: -88.5, south: 16, east: -87.3, north: 18.2 } });
    expect(String(belize.data.note)).toMatch(/thin/i);
    for (const [place, areaId] of [
      ["Cozumel", "mx-caribbean"],
      ["Banco Chinchorro", "mx-caribbean"],
      ["Glover's Reef", "belize"],
      ["Turneffe", "belize"],
      ["San Andrés", "co-caribbean"],
      ["san andres", "co-caribbean"],
      ["Looe Key", "fl-keys"],
      ["Key Largo", "fl-keys"],
    ] as const) {
      const out = await run("geocode", { place });
      expect([place, out.data.areaId]).toEqual([place, areaId]);
    }
    expect(stub.requests).toHaveLength(0);
    // Open-Meteo would be asked for an unknown name; the stub is offline, so the refusal must come from the regions check.
    const nassau = await registry.execute("geocode", { place: "Nassau" }, { ...ctx, signal: AbortSignal.abort() });
    expect(nassau.ok).toBe(false);
  });
});

describe("lionfish tool: reef_heat", () => {
  test("lionfish tool: the latest CRW product per area carries SST, anomaly, DHW and BAA together, with unit, source, product date, age and one cite marker per value", async () => {
    const out = await run("reef_heat", {});
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentReadings"]);
    expect(stub.requests[0]!.variables.params).toEqual(["SST", "SST_ANOMALY", "DHW", "BAA"]);
    const areas = out.data.areas as any[];
    expect(areas.map((a) => a.area)).toEqual(["belize", "co-caribbean", "fl-keys", "fl-keys", "mx-caribbean", "mx-caribbean"]);
    const looe = areas.find((a) => a.station === "crw-fl-looe")!;
    expect(looe).toMatchObject({ areaName: "Florida Keys / South Florida", productDate: "2026-09-29", latencyDays: 2, dataAge: "2 days old", dhwCWeeks: 13.65, baa: 1, baaLabel: "Bleaching Watch", sstC: 30.04, anomalyC: 1.52, thinArea: false });
    expect(looe.units).toEqual({ sstC: "°C", anomalyC: "°C above the climatological maximum month", dhwCWeeks: "°C-weeks", baa: "bleaching alert level 0-4" });
    const at = Date.parse("2026-09-29T12:00:00Z");
    expect(looe.cite).toEqual({ sst: `[e:reading:crw-fl-looe:sst:${at}:satellite]`, anomaly: `[e:reading:crw-fl-looe:sst_anomaly:${at}:satellite]`, dhw: `[e:reading:crw-fl-looe:dhw:${at}:satellite]`, baa: `[e:reading:crw-fl-looe:baa:${at}:satellite]` });
    const glovers = areas.find((a) => a.station === "crw-bz-glovers")!;
    expect(glovers).toMatchObject({ area: "belize", thinArea: true, dhwCWeeks: 5.28, baa: 3, baaLabel: "Bleaching Alert Level 1" });
    expect(String(out.data.note)).toMatch(/DHW .*accumulates/);
    expect(String(out.data.note)).toMatch(/context for survey planning, not proof/);
    expect(String(out.data.credit)).toMatch(/NOAA Coral Reef Watch/);
    expect(String(out.data.source)).toBe("NOAA Coral Reef Watch (crw)");
    expectEvidenceFormat(out, ["crw"]);
    expect(out.feeds.map((f) => f.source)).toEqual(["crw"]);
    expectView("reef_heat", out);
    expect((viewOf(out)!.result as TableView).view).toBe("table");
    expectHonestKeys(out);
  });

  test("lionfish tool: a daily series over 30 days gives the change, the peak with its date and the alert-level changes, each cited", async () => {
    const out = await run("reef_heat", { place: "Looe Key", days: 30 });
    const areas = out.data.areas as any[];
    expect(areas.map((a) => a.station)).toEqual(["crw-fl-looe"]);
    const series = areas[0].series;
    // 30 days back from the reference time is 2026-09-01; the newest product is 2026-09-29: 29 daily points.
    expect(series).toMatchObject({ days: 30, from: "2026-09-01", to: "2026-09-29", points: 29, dhwEnd: 13.65, baaStart: 3, baaEnd: 1 });
    expect(series.dhwPeak).toMatchObject({ dhwCWeeks: 14.2, date: "2026-09-10" });
    expect(series.dhwPeak.cite).toMatch(/^\[e:reading:crw-fl-looe:dhw:\d+:satellite\]$/);
    expect(series.baaChanges).toEqual([
      { date: "2026-09-12", from: 3, to: 2, label: "Bleaching Warning" },
      { date: "2026-09-22", from: 2, to: 1, label: "Bleaching Watch" },
    ]);
    expect(series.dhwChange).toBeCloseTo(13.65 - series.dhwStart, 1);
    expect(series.daily).toHaveLength(29);
    expect((viewOf(out)!.result as SeriesView).view).toBe("series");
    // A week: Belize's alert level rose to 3 on 2026-09-27; Florida's did not change.
    const week = await run("reef_heat", { days: 7 });
    const byStation = Object.fromEntries((week.data.areas as any[]).map((a) => [a.station, a.series.baaChanges]));
    expect(byStation["crw-bz-glovers"]).toEqual([{ date: "2026-09-27", from: 2, to: 3, label: "Bleaching Alert Level 1" }]);
    expect(byStation["crw-fl-looe"]).toEqual([]);
    // A masked pixel day is a gap, not a zero.
    const mx = await run("reef_heat", { area: "mx-caribbean", days: 30 });
    expect((mx.data.areas as any[]).find((a) => a.station === "crw-mx-chinchorro").series.missingDays).toEqual(["2026-09-16"]);
  });

  test("lionfish tool: a past `at` replays the product known then; a place outside the areas is refused", async () => {
    const past = await run("reef_heat", { area: "belize", at: "2026-09-01T12:00:00Z" });
    expect((past.data.areas as any[])[0]).toMatchObject({ productDate: "2026-09-01", baa: 2, baaLabel: "Bleaching Warning" });
    expect(past.data.asOf).toBe("2026-09-01T12:00:00.000Z");
    // An unknown place widens to the four areas and says so (the scope guard refuses places outside them before any tool runs).
    const unknown = await run("reef_heat", { place: "Nassau, Bahamas" });
    expect(String(unknown.data.placeIgnored)).toMatch(/not a place the app knows/);
    expect((unknown.data.areas as any[]).length).toBe(6);
  });
});

describe("lionfish tool: marine_forecast", () => {
  test("lionfish tool: 72 h of modelled waves and currents per point, daily summaries with cite markers, km/h next to m/s, the horizon and the separation note", async () => {
    const out = await run("marine_forecast", {});
    expect(stub.requests[0]!.variables.params).toEqual(["WAVE_M", "WAVE_PERIOD_S", "CURRENT_MS", "CURRENT_DIR_DEG"]);
    expect(out.data).toMatchObject({ source: "Open-Meteo Marine (openmeteo-marine)", horizonHours: 72, horizonEnd: "2026-10-04T12:00:00.000Z", fetchedAt: "2026-10-01T11:00:00Z", calmThresholdM: 1.2 });
    expect(String(out.data.note)).toMatch(/modelled, not measured/);
    expect(String(out.data.note)).toMatch(/separate from the survey priority score/);
    expect(String(out.data.note)).toMatch(/Never say a dive is safe/);
    const points = out.data.points as any[];
    expect(points.map((p) => p.station).sort()).toEqual(["om-chinchorro", "om-cozumel", "om-glovers", "om-keylargo", "om-looe", "om-sanandres"]);
    const chinchorro = points.find((p) => p.station === "om-chinchorro")!;
    expect(chinchorro.area).toBe("mx-caribbean");
    expect(chinchorro.daily.map((d: any) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(chinchorro.daily[0].weekday).toBe("Thursday");
    const saturday = chinchorro.daily.find((d: any) => d.weekday === "Saturday")!;
    expect(saturday.currentMaxKmh).toBeCloseTo(saturday.currentMaxMs * 3.6, 1);
    expect(saturday.currentMaxKmh).toBeGreaterThan(2.5);
    expect(saturday.cite).toMatch(/^\[e:reading:om-chinchorro:wave_m:\d+:modeled\]$/);
    expect(saturday.citeCurrent).toMatch(/^\[e:reading:om-chinchorro:current_ms:\d+:modeled\]$/);
    // Hourly rows come only with a single point; an all-areas call keeps to the daily summaries.
    expect(chinchorro.hourly).toBeUndefined();
    const one = await run("marine_forecast", { place: "Banco Chinchorro" });
    const hourly = (one.data.points as any[])[0].hourly as any[];
    expect(hourly[0]).toMatchObject({ waveM: expect.any(Number), currentKmh: expect.any(Number), currentDirDeg: expect.any(Number) });
    expect(hourly[0].atLocal).toMatch(/EDT$/);
    // Calmest first: the Keys drop below 0.5 m while Cozumel builds past 1.8 m.
    const ranked = out.data.calmestFirst as any[];
    expect(ranked[0].station).toBe("om-keylargo");
    expect(ranked.at(-1).station).toBe("om-cozumel");
    expect(points.find((p) => p.station === "om-cozumel").waveTrend).toBe("building");
    expect(points.find((p) => p.station === "om-looe").waveTrend).toBe("dropping");
    expectEvidenceFormat(out, ["openmeteo-marine"]);
    expect(out.feeds.map((f) => f.source)).toEqual(["openmeteo-marine"]);
    expectView("marine_forecast", out);
    expectHonestKeys(out);
  });

  test("lionfish tool: a place, an area or a point picks its forecast point; outside the areas is refused", async () => {
    const cozumel = await run("marine_forecast", { place: "Cozumel", days: 1 });
    expect((cozumel.data.points as any[]).map((p) => p.station)).toEqual(["om-cozumel"]);
    expect(cozumel.data.place).toBe("Cozumel");
    const belize = await run("marine_forecast", { area: "Belize" });
    expect((belize.data.points as any[]).map((p) => p.station)).toEqual(["om-glovers"]);
    const point = await run("marine_forecast", { lat: 12.5, lon: -81.7 });
    expect((point.data.points as any[]).map((p) => p.station)).toEqual(["om-sanandres"]);
    expect((point.data.points as any[])[0].distanceDeg).toBeLessThan(0.2);
    // A reef reads its whole area and keeps the nearest grid point, so a reef far from any point still gets one.
    const looe = await run("marine_forecast", { place: "Looe Key", days: 1 });
    expect((looe.data.points as any[]).map((p) => p.station)).toEqual(["om-looe"]);
    expect(String(looe.data.horizonLine)).toMatch(/covers 72 hours \(three days\)/);
    // The day asked about: inside the horizon it points at the daily row, beyond it the result says so and gives no number.
    const soon = await run("marine_forecast", { place: "Cozumel", date: "2026-10-02" });
    expect(soon.data.asked).toMatchObject({ date: "2026-10-02", covered: true });
    const far = await run("marine_forecast", { place: "Cozumel", date: "2026-10-15" });
    expect(far.data.asked).toMatchObject({ date: "2026-10-15", covered: false });
    expect(String((far.data.asked as any).say)).toMatch(/cannot reach 2026-10-15/);
    const unknown = await run("marine_forecast", { place: "Roatan" });
    expect(String(unknown.data.placeIgnored)).toMatch(/not a place the app knows/);
    expect((unknown.data.points as any[]).length).toBe(6);
    expect(await registry.execute("marine_forecast", { lat: 25.0, lon: -77.4 }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining(LIONFISH.agent.refusal) });
  });
});

describe("lionfish tool: hotspots and explain_cell (components)", () => {
  test("lionfish tool: hotspots returns the four components separately per cell with state and weight, heat with DHW and BAA, a field window, rankScore and thin flags, never a percent", async () => {
    const out = await run("hotspots", { species: "lionfish" });
    expect(stub.requests[0]!.variables).toMatchObject({ species: "lionfish", top: 10, region: null });
    expect(out.data).toMatchObject({ species: "lionfish", heuristic: true, basis: "submitted", weights: { recentReports: 1, idQuality: 1, heatStress: 1 } });
    expect(String(out.data.note)).toMatch(/not a probability, a risk, an invasion-risk percent/);
    const cells = out.data.cells as any[];
    expect(cells[0]).toMatchObject({ cell: "mx-caribbean:87:205", area: "mx-caribbean", rankScore: 0.81, thin: false });
    expect(cells[0].cite).toBe(`[e:hotspot:lionfish:mx-caribbean:87:205:${NOW.getTime()}]`);
    expect(Object.keys(cells[0].components)).toEqual(["recentReports", "idQuality", "heatStress", "completeness"]);
    expect(cells[0].components.recentReports).toMatchObject({ value: 1, state: "ok", weight: 1 });
    expect(cells[0].components.completeness).toMatchObject({ weight: 0 });
    // The ranking carries no reasons (those come from explain_cell) and a summary line with the marker per cell.
    expect(cells[0].components.recentReports.rationale).toBeUndefined();
    expect(String(cells[0].summary)).toMatch(/^Mexican Caribbean cell mx-caribbean:87:205: rankScore 0.81 \(a heuristic that only orders cells\); recent reports 1 \(ok, weight 1\).*\[e:hotspot:lionfish:mx-caribbean:87:205:\d+\]$/);
    expect(String(out.data.say)).toMatch(/needs explain_cell/);
    expect(cells[0].heat).toMatchObject({ dhwCWeeks: 8.1, baa: 3, baaLabel: "Bleaching Alert Level 1", productDate: "2026-09-29", dataAge: "2 days old" });
    expect(cells[0].heat.cite.dhw).toMatch(/^\[e:reading:crw-mx-cozumel:dhw:\d+:satellite\]$/);
    expect(cells[0].fieldWindow).toMatchObject({ state: "ok", horizonHours: 72, currentMaxKmh: expect.any(Number) });
    expect(String(cells[0].fieldWindow.note)).toMatch(/never part of the rank/);
    const belize = cells.find((c) => c.area === "belize")!;
    expect(belize).toMatchObject({ rankScore: null, thin: true });
    expect(belize.components.recentReports).toMatchObject({ value: null, state: "unknown" });
    expect(String(belize.thinNote)).toMatch(/unknown \(not zero\)/);
    const byArea = out.data.byArea as any[];
    expect(byArea.map((a) => [a.area, a.thin, a.topCell?.cell ?? null])).toEqual([
      ["fl-keys", false, "fl-keys:179:24"],
      ["mx-caribbean", false, "mx-caribbean:87:205"],
      ["belize", true, "belize:72:82"],
      ["co-caribbean", true, "co-caribbean:10:285"],
    ]);
    expectEvidenceFormat(out, ["crw"]);
    expect(out.evidence.filter((e) => e.kind === "hotspot")).toHaveLength(8);
    expectView("hotspots", out);
    expectHonestKeys(out);
    expect(JSON.stringify(out.data)).not.toMatch(/\d+(\.\d+)?\s*%/);
  });

  test("lionfish tool: an area ranks within itself; a past `at` replays the ranking known then; weights reorder", async () => {
    const fl = await run("hotspots", { species: "lionfish", area: "Florida Keys" });
    expect(stub.requests[0]!.variables.region).toBe("fl-keys");
    expect((fl.data.cells as any[]).map((c) => c.cell)).toEqual(["fl-keys:179:24", "fl-keys:282:71", "fl-keys:209:32"]);
    expect(fl.data.area).toBe("fl-keys");
    const past = await run("hotspots", { species: "lionfish", at: new Date(NOW.getTime() - 14 * DAY).toISOString() });
    expect((past.data.cells as any[])[0].cell).toBe("fl-keys:179:24");
    const heavy = await run("hotspots", { species: "lionfish", weights: { recentReports: 0, idQuality: 0, heatStress: 1 } });
    expect((heavy.data.cells as any[])[0].area).toBe("fl-keys");
    expect(heavy.data.weights).toEqual({ recentReports: 0, idQuality: 0, heatStress: 1 });
    expect(await registry.execute("hotspots", { species: "lionfish", area: "Bahamas" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining(LIONFISH.agent.refusal) });
    expect(await registry.execute("hotspots", { species: "python" }, ctx)).toMatchObject({ ok: false, code: "invalid_input" });
  });

  test("lionfish tool: explain_cell lists every record behind the components with observed and submitted dates, weights and duplicates, the CRW values and the caveats", async () => {
    const out = await run("explain_cell", { species: "lionfish", cell: "mx-caribbean:87:205" });
    expect(out.data).toMatchObject({ cell: "mx-caribbean:87:205", area: "mx-caribbean", rankScore: 0.81, heuristic: true, centre: { lat: 20.355, lon: -87.025 } });
    expect(out.data.caveats).toHaveLength(4);
    expect(String(out.data.credit)).toMatch(/NOAA Coral Reef Watch/);
    const recent = (out.data as any).components.recentReports;
    const byId = Object.fromEntries(recent.evidence.map((e: any) => [e.id, e]));
    expect(byId["sighting:8001"]).toMatchObject({ counted: true, weight: 1, observedAt: "2026-09-29T15:00:00Z", submittedAt: "2026-09-30T02:00:00Z", lagDays: 0.5, cite: "[e:sighting:8001]" });
    expect(byId["sighting:8015"]).toMatchObject({ counted: false, weight: null, observedAt: "2021-03-11T15:00:00Z" });
    expect(typeof byId["sighting:8015"].lagDays).toBe("number");
    expect(Number(byId["sighting:8015"].lagDays)).toBeGreaterThan(2000);
    expect(byId["sighting:8020"].detail).toMatch(/history record, static prior weight 0.20/);
    expect(recent.citeInputs).toContain("[e:sighting:8001]");
    const heat = (out.data as any).components.heatStress;
    expect(heat.evidence.map((e: any) => e.id.split(":")[2])).toEqual(["dhw", "baa", "sst", "sst_anomaly"]);
    expect((out.data as any).heat).toMatchObject({ dhwCWeeks: 8.1, baa: 3 });
    // Evidence rows: the hotspot, the CRW readings (feed crw) and every input sighting with its feed.
    expectEvidenceFormat(out, ["crw", "inat", "gbif", "nas"]);
    expect(out.evidence.find((e) => e.id === "sighting:8019")?.feed).toBe("gbif");
    expect(out.evidence.find((e) => e.id === "sighting:8020")?.feed).toBe("nas");
    expectView("explain_cell", out);
    expectHonestKeys(out);
    // An area explains its top cell; a point maps to its cell.
    const belize = await run("explain_cell", { species: "lionfish", area: "Belize" });
    expect(belize.data).toMatchObject({ cell: "belize:72:82", rankScore: null, thin: true });
    const point = await run("explain_cell", { species: "lionfish", lat: 24.546, lon: -81.406 });
    expect(point.data.cell).toBe("fl-keys:179:24");
    // Placeholders beside an area (cell "0:0", lat 0, lon 0) still land on the area named.
    const filled = await run("explain_cell", { species: "lionfish", cell: "0:0", lat: 0, lon: 0, area: "Florida Keys" });
    expect(filled.data.cell).toBe("fl-keys:179:24");
    expect(String(filled.data.summary)).toMatch(/^Florida Keys \/ South Florida cell fl-keys:179:24: rankScore 0.62/);
    expect(String(belize.data.thinNote)).toMatch(/^Belize is a thin area: .*still shows heat stress \(DHW 5.28 °C-weeks, alert level 3, product day 2026-09-29\) and the history records from GBIF and NAS \[e:hotspot:lionfish:belize:72:82:\d+\]$/);
    // Nothing given: the top cell of the four areas, with the recipe, the summary line and the newest counted report's age.
    const top = await run("explain_cell", { species: "lionfish" });
    expect(top.data).toMatchObject({ cell: "mx-caribbean:87:205", newestReport: { id: "sighting:8001", observedAge: "1.9 days old" } });
    expect(String(top.data.recipe)).toMatch(/^How the score is built: recent reports \(weight 1\): kernel-weighted.*completeness \(weight 0, lowers confidence, never the rank\).*\[e:hotspot:lionfish:mx-caribbean:87:205:\d+\]$/);
    expect(String(top.data.summary)).toMatch(/\[e:hotspot:/);
    expect(String(top.data.next)).toMatch(/call sightings for Mexican Caribbean/);
  });
});

describe("lionfish tool: sightings, conditions and set_view changes", () => {
  test("lionfish tool: sightings default to the app's 30-day window, carry submitted dates, lag days, area, imprecise and late flags, and GBIF copies as duplicates", async () => {
    const out = await run("sightings", { species: ["lionfish"] });
    // The default 30-day window is fetched over the 90-day backfill reach: three 31-day pages, the API's cap.
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentSightings", "AgentSightings", "AgentSightings"]);
    expect(out.data.window).toMatchObject({ from: new Date(NOW.getTime() - 30 * DAY).toISOString() });
    const byArea = out.data.byArea as Record<string, { name: string; reports: number; distinct: number; thin: boolean }>;
    expect(byArea["fl-keys"]).toEqual({ name: "Florida Keys / South Florida", thin: false, reports: 6, distinct: 4 });
    expect(byArea["mx-caribbean"]).toMatchObject({ reports: 10, distinct: 8 });
    expect(byArea.belize).toMatchObject({ reports: 0, distinct: 0, thin: true });
    expect(byArea["co-caribbean"]).toMatchObject({ reports: 2, distinct: 2, thin: true });
    expect(String(out.data.sightingsNote)).toMatch(/not abundance/);
    expect(String(out.data.dateField)).toMatch(/^observed/);
    const rows = out.data.rows as any[];
    const row = rows.find((r) => r.evidenceId === "sighting:7003")!;
    expect(row).toMatchObject({ observedAt: "2026-09-05T16:40:00Z", submittedAt: "2026-09-26T11:30:00Z", lagDays: 20.8, area: "fl-keys", quality: "needs_id", arrivedLate: "21 days after it was observed" });
    expect(rows.find((r) => r.evidenceId === "sighting:7010")).toMatchObject({ source: "gbif", duplicateOf: "sighting:7001 (a copy: not counted)" });
    expect(String(out.data.duplicateNote)).toMatch(/never counted as a second animal/);
    expect(rows.find((r) => r.evidenceId === "sighting:9502")).toMatchObject({ imprecise: "no accuracy given (possibly obscured)", area: "co-caribbean" });
    // Two imprecise rows: the mid-sea Colombian report and a NAS record with no accuracy.
    expect(out.data.imprecise).toBe(2);
    expect((out.data.impreciseRecords as any[]).find((r) => r.cite === "[e:sighting:9502]")).toMatchObject({ lat: 12.46, lon: -76.92, why: "no positional accuracy given (coordinates may be obscured)" });
    expect((out.data.lateRecords as any[]).map((r) => r.cite)).toContain("[e:sighting:7003]");
    expect(out.feeds.map((f) => f.source).sort()).toEqual(["gbif", "inat", "nas"]);
    expect(out.evidence.find((e) => e.id === "sighting:7014")?.feed).toBe("nas");
    expect(out.evidence.find((e) => e.id === "sighting:8001")?.feed).toBe("inat");
    // Florida this week: none, and the result says the window was widened rather than inventing a count.
    const fl = await run("sightings", { species: ["lionfish"], bbox: findArea(LIONFISH, "fl-keys")!.bbox, hours: 168 });
    expect(fl.data.total).toBeGreaterThan(0);
    expect(String(fl.data.widened)).toMatch(/Nothing in the 7 days asked for/);
  });

  test("lionfish tool: dateField submitted counts by arrival and surfaces old dives uploaded this month; knownAt replays what had arrived by a date", async () => {
    const submitted = await run("sightings", { species: ["lionfish"], dateField: "submitted", hours: 720 });
    const rows = submitted.data.rows as any[];
    // The API searches by observed date in 31-day pages: a 90-day reach is three requests, and a dive observed years
    // ago and uploaded this month (7009, 8015) is beyond it; the result says so instead of pretending.
    expect(stub.requests.filter((r) => r.operationName === "AgentSightings")).toHaveLength(3);
    expect(stub.requests.every((r) => Date.parse(String(r.variables.to)) - Date.parse(String(r.variables.from)) <= 31 * DAY)).toBe(true);
    expect(rows.map((r) => r.evidenceId)).toContain("sighting:8011");
    expect(rows.find((r) => r.evidenceId === "sighting:8011")).toMatchObject({ observedAt: "2026-08-16T14:00:00Z", submittedAt: "2026-09-20T12:00:00Z", lagDays: 34.9 });
    expect(rows.map((r) => r.evidenceId)).not.toContain("sighting:8015");
    expect(String(submitted.data.reachNote)).toMatch(/up to 90 days back/);
    expect(String(submitted.data.dateField)).toMatch(/^submitted/);
    expect(submitted.data.widened).toBeUndefined();
    // The stub refuses a window over 31 days as the API does.
    expect(await registry.execute("conditions", { params: ["sst_c"], hours: 24 * 40 }, ctx)).toMatchObject({ ok: true });
    // One feed's newest record in reach, per source: NAS has nothing in Colombia within 90 days, iNaturalist has.
    const nas = await run("sightings", { species: ["lionfish"], bbox: findArea(LIONFISH, "co-caribbean")!.bbox, hours: 2160, source: "nas" });
    expect(nas.data.total).toBe(0);
    expect((nas.data.newestBySource as any).nas.none).toMatch(/no nas record in this box in the last 90 days/);
    expect((nas.data.newestBySource as any).inat).toMatchObject({ cite: "[e:sighting:9501]", observedAge: "1.8 days old" });
    expect(nas.evidence.map((e) => e.id)).toContain("sighting:9501");
    const known = await run("sightings", { species: ["lionfish"], bbox: findArea(LIONFISH, "belize")!.bbox, hours: 2160, knownAt: "2026-09-01T00:00:00Z" });
    const ids = (known.data.rows as any[]).map((r) => r.evidenceId);
    expect(ids).toContain("sighting:9001");
    expect(ids).not.toContain("sighting:9003");
    expect(String(known.data.knownAtNote)).toMatch(/later arrivals are listed under sinceThen/);
    // The GBIF copy reached the feed on 2026-09-10: it is what arrived after the knowledge time.
    expect((known.data.sinceThen as { arrivedAfter: number; rows: { evidenceId: string }[] }).arrivedAfter).toBe(1);
    expect((known.data.sinceThen as { rows: { evidenceId: string }[] }).rows.map((r) => r.evidenceId)).toEqual(["sighting:9003"]);
  });

  test("lionfish tool: conditions compares buoys with GOES-19 SST in Florida and says no buoy exists in the other areas, with feed-tagged reading evidence", async () => {
    const out = await run("conditions", { params: ["sst_c", "water_c"] });
    const conflicts = out.data.conflicts as any[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ param: "sst_c", area: "fl-keys", prefer: "measured" });
    expect(conflicts[0].delta).toBeGreaterThan(1.5);
    expect(out.data.coverage).toMatchObject({ withMeasuredStations: ["Florida Keys / South Florida"], withoutMeasuredStations: ["Mexican Caribbean", "Belize", "Colombian Caribbean"] });
    expect(out.evidence.find((e) => e.id.startsWith("reading:MLRF1:"))?.feed).toBe("ndbc");
    expect(out.evidence.find((e) => e.id.startsWith("reading:goes-fl-molasses:"))?.feed).toBe("goes19-sst");
    // The latest Molasses Reef pass is usable; cloud-masked passes earlier in the day are gaps in the series, not values.
    expect(Array.isArray(out.data.missing)).toBe(true);
    expect((out.data.rows as any[]).find((r) => r.station === "GOES-19 SST cell Molasses Reef").samples).toBe(24);
  });

  test("lionfish tool: set_view frames an area, all four or a box, switches layers, toggles the basis and sets a knowledge time, emitting the UL view contract", async () => {
    const belize = await run("set_view", { area: "Belize", layers: ["heat", "priority"], basis: "observed" });
    expect(belize.data).toMatchObject({ preset: "belize", area: "belize", areaName: "Belize", thin: true, layers: ["heat", "hotspots"], basis: "observed", applied: true });
    expect(emitted).toEqual([{ type: "view", bbox: { west: -88.5, south: 16, east: -87.3, north: 18.2 }, time: NOW.toISOString(), preset: "belize", region: "belize", area: "belize", layers: ["heat", "hotspots"], basis: "observed" }]);
    emitted.length = 0;
    const replay = await run("set_view", { preset: "mx-caribbean", asOf: "2026-09-01T00:00:00Z", layers: ["waves", "sightings", "field window"] });
    expect(replay.data).toMatchObject({ preset: "mx-caribbean", asOf: "2026-09-01T00:00:00.000Z", replay: true, layers: ["marine", "sightings"] });
    expect(emitted[0]).toMatchObject({ type: "view", preset: "mx-caribbean", region: "mx-caribbean", asOf: Date.parse("2026-09-01T00:00:00Z"), replay: true, time: "2026-09-01T00:00:00.000Z", layers: ["marine", "sightings"] });
    emitted.length = 0;
    const all = await run("set_view", { area: "all", time: "2026-09-10T12:00:00Z" });
    expect(all.data).toMatchObject({ preset: "all-areas", area: "all-areas", time: "2026-09-10T12:00:00.000Z" });
    expect(emitted[0]).toMatchObject({ type: "view", preset: "all-areas", bbox: { west: -88.5, south: 9.7, east: -74, north: 27.5 } });
    expect((emitted[0] as any).region).toBeUndefined();
    emitted.length = 0;
    const box = await run("set_view", { bbox: { west: -87.1, south: 20.2, east: -86.7, north: 20.6 }, layers: ["nonsense"] });
    expect(box.data).toMatchObject({ preset: "all-areas", unknownLayers: ["nonsense"] });
    expect((emitted[0] as any).layers).toBeUndefined();
    expect(await registry.execute("set_view", { area: "Honduras" }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining(LIONFISH.agent.refusal) });
    expect(await registry.execute("set_view", { bbox: { west: -78, south: 24, east: -77, north: 25 } }, ctx)).toMatchObject({ ok: false, error: expect.stringContaining(LIONFISH.agent.refusal) });
  });

  test("lionfish tool: evidence, source_info, feed_state, notes and team_board answer over the lionfish fixture with feed-tagged records", async () => {
    const sighting = await run("evidence", { id: "sighting:7010" });
    expect(sighting.data).toMatchObject({ kind: "sighting", feed: "gbif", sourcePageUrl: "https://www.gbif.org/occurrence/gbif-7010" });
    expect((sighting.data.links as any[])[0]).toMatchObject({ relation: "duplicateOf", id: "sighting:7001" });
    const crw = await run("evidence", { id: `reading:crw-fl-looe:dhw:${Date.parse("2026-09-29T12:00:00Z")}:satellite` });
    expect(crw.data.feed).toBe("crw");
    expect(String((crw.data.record as any).credit)).toMatch(/NOAA Coral Reef Watch/);
    expect(String((crw.data.record as any).doi)).toMatch(/doi\.org/);
    expect(String(crw.data.sourceUrl)).toMatch(/dhw_5km/);
    // The lag in days is a tool value (never the model's arithmetic); a hotspot record lists the dated records inside it with ages.
    const late = await run("evidence", { id: "sighting:7003" });
    expect(late.data).toMatchObject({ ingestLagDays: 20.8, ingestLagWords: "20.8 days later" });
    expect(late.data.recordsInside).toBeUndefined();
    const hotspot = await run("evidence", { id: `hotspot:lionfish:mx-caribbean:87:205:${NOW.getTime()}` });
    expect(hotspot.data.newestSightingInside).toMatchObject({ id: "sighting:8001", observedAt: "2026-09-29T15:00:00Z", observedAge: "1.9 days old" });
    expect((hotspot.data.recordsInside as any[]).length).toBeGreaterThan(4);
    const sources = await run("source_info", {});
    const rows = sources.data.rows as any[];
    expect(rows.map((r) => r.feed)).toEqual(["inat", "gbif", "nas", "crw", "openmeteo-marine", "ndbc", "goes19-sst"]);
    // Each feed's facts point at the tool that shows its rows; "all" means every feed.
    expect(String(rows.find((r) => r.feed === "nas").next)).toMatch(/call sightings over the four areas/);
    expect(String(rows.find((r) => r.feed === "crw").next)).toMatch(/call reef_heat/);
    expect(rows.find((r) => r.feed === "ndbc").next).toBeUndefined();
    expect(((await run("source_info", { feed: "all" })).data.rows as any[]).length).toBe(7);
    expect(rows.find((r) => r.feed === "openmeteo-marine").licence).toMatch(/non-commercial/);
    expect(rows.find((r) => r.feed === "crw").attribution).toMatch(/NOAA Coral Reef Watch/);
    expect(rows.find((r) => r.feed === "crw").licence).toMatch(/credit to NOAA Coral Reef Watch/);
    expect(rows.find((r) => r.feed === "goes19-sst").coverage).toMatch(/full disk/);
    const feeds = await run("feed_state", {});
    expect(feeds.feeds.map((f) => `${f.source}:${f.state}`)).toEqual(["inat:nominal", "gbif:lagging", "nas:stale", "crw:nominal", "openmeteo-marine:nominal", "ndbc:nominal", "goes19-sst:nominal"]);
    expect(feeds.evidence.map((e) => e.id)).toContain("fetch:lf-crw-7299");
    const notes = await run("notes", { hours: 168 });
    expect(notes.data.total).toBe(6);
    expect((notes.data.rows as any[])[0]).toMatchObject({ cite: expect.stringMatching(/^\[e:note:/), age: expect.stringMatching(/hours old$/) });
    const board = await run("team_board", { kind: "missions" });
    expect((board.data.missions as any[]).map((m) => m.title)).toHaveLength(3);
    const belize = await run("team_board", { kind: "messages", about: "Belize", hours: 24 });
    expect((belize.data.messages as any[]).map((m) => m.from)).toEqual(["Ops-Lead", "Team-BZ"]);
  });
});
