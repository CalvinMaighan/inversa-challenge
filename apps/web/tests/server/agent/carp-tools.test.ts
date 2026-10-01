/* eslint-disable @typescript-eslint/no-explicit-any -- tool rows are read loosely */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CARP_FIXTURE_NOW } from "@/eval/stub-carp";
import { startStub, type Stub } from "@/eval/stub-server";
import { checkViews } from "@/eval/views";
import type { CapabilityContext, CapabilityOutput } from "@/server/agent/runtime/registry";
import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { parseEvidenceId } from "@/server/agent/tools/evidence";
import { categoryOf, forecastRiseRate, review, transitions, type Review } from "@/server/agent/tools/review";
import { findSite, presetBox, resolveSites } from "@/server/agent/tools/sites";
import { viewOf } from "@/server/agent/tools/views";
import type { AgentStreamEvent } from "@/shared/agent/events";
import type { SeriesView, TableView } from "@/shared/agent/results";
import { getApp } from "@/shared/apps";

/**
 * The carp tools (gates/leaf-AG1.md G2) against the fixture GraphQL stub: inputs and outputs as
 * spec/apps/questions/carp.json `newTools` specifies them, units and source labels on every value, asOf
 * everywhere, -9999 as missing, notMeasured flags, datum notes, provenance nwps-live / iem-archive, and
 * evidence rows in the C14 record format with their feed.
 */

const CARP = getApp("carp");
const NOW = new Date(CARP_FIXTURE_NOW);
const HOUR = 3_600_000;

let stub: Stub;
let dataDir: string;
const emitted: AgentStreamEvent[] = [];
const ctx: CapabilityContext = { app: CARP, now: NOW, emit: (event) => emitted.push(event) };
const registry = buildAgentRegistry(CARP);

beforeAll(() => {
  stub = startStub();
  dataDir = mkdtempSync(join(tmpdir(), "inversa-carp-tools-"));
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

async function run(name: string, input: unknown, at: CapabilityContext = ctx): Promise<CapabilityOutput> {
  const result = await registry.execute(name, input, at);
  if (!result.ok) throw new Error(result.error);
  return result.output;
}

/** Every evidence row is `<kind>:<key>` with a known kind, and data rows carry it as a feed-tagged record. */
function expectEvidenceFormat(out: CapabilityOutput, feeds: string[]): void {
  expect(out.evidence.length).toBeGreaterThan(0);
  for (const row of out.evidence) {
    const parsed = parseEvidenceId(row.id);
    expect(parsed?.kind).toBe(row.kind);
    expect(row.label.length).toBeGreaterThan(3);
    expect(row.id).not.toContain(",");
  }
  for (const feed of feeds) expect(out.evidence.some((row) => row.feed === feed)).toBe(true);
}

/** Every successful data tool call puts a valid C17 view in tool_end.data. */
function expectView(name: string, out: CapabilityOutput): void {
  const event: AgentStreamEvent = { type: "tool_end", toolCallId: "t", capabilityName: name, ok: true, data: { count: out.count, evidence: out.evidence, feeds: out.feeds, ...viewOf(out) } };
  expect(checkViews([event])).toEqual({ valid: 1, total: 1, reasons: [] });
}

describe("carp tool registry", () => {
  test("carp tool: the carp config registers exactly its allowlist, the river tools exist only for a conditions app, and source_info/evidence/team_board exist for every app", () => {
    const names = registry.list().map((cap) => cap.name);
    expect([...names].sort()).toEqual([...CARP.agent.tools].sort());
    for (const tool of ["site_status", "river_readings", "river_forecast", "forecast_verify", "review_history", "weather_forecast"]) expect(names).toContain(tool);
    for (const other of ["python", "lionfish"] as const) {
      const app = getApp(other);
      const stubbed = { ...app, agent: { ...app.agent, tools: [...app.agent.tools, "source_info", "evidence", "team_board"] } };
      const reg = buildAgentRegistry(stubbed);
      for (const tool of ["source_info", "evidence", "team_board"]) expect(reg.get(tool)).toBeDefined();
      expect(() => buildAgentRegistry({ ...app, agent: { ...app.agent, tools: [...app.agent.tools, "site_status"] } })).toThrow(/unknown tools: site_status/);
    }
    expect(registry.get("sightings")).toBeUndefined();
    expect(registry.get("hotspots")).toBeUndefined();
  });

  test("carp tool: sites resolve by lid, town, name and preset; an unknown place gets the refusal", () => {
    expect(findSite(CARP, "MCGL1")?.lid).toBe("MCGL1");
    expect(findSite(CARP, "morgan city")?.lid).toBe("MCGL1");
    expect(findSite(CARP, "Krotz Springs")?.lid).toBe("KRZL1");
    expect(findSite(CARP, "Atchafalaya River above Butte La Rose")?.lid).toBe("BLRL1");
    expect(findSite(CARP, "Baton Rouge")?.lid).toBe("BTRL1");
    expect(resolveSites(CARP, undefined).map((s) => s.lid)).toEqual(["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"]);
    expect(resolveSites(CARP, ["Atchafalaya"]).map((s) => s.lid)).toEqual(["SMML1", "KRZL1", "BLRL1", "MCGL1"]);
    expect(resolveSites(CARP, ["Monroe", "Bogalusa"]).map((s) => s.lid)).toEqual(["MLUL1", "BXAL1"]);
    expect(() => resolveSites(CARP, ["Sabine River at Orange"])).toThrow(CARP.agent.refusal);
    expect(findSite(CARP, "Orange, Texas")).toBeNull();
    const box = presetBox({ lat: 30.35, lon: -91.55, zoom: 8.5 });
    expect(box.west).toBeLessThan(-91.55);
    expect(box.east).toBeGreaterThan(-91.55);
  });
});

describe("carp tool: review rules (pure)", () => {
  const th = { action: 4, minor: 6, moderate: 7, major: 12, lowThreshold: null };

  test("categories are 'at or above' NWPS thresholds; -9999 (null) thresholds give no category", () => {
    expect(categoryOf(3.99, th)).toBe("none");
    expect(categoryOf(4, th)).toBe("action");
    expect(categoryOf(6.5, th)).toBe("minor");
    expect(categoryOf(12, th)).toBe("major");
    expect(categoryOf(5, { action: null, minor: null, moderate: null, major: null })).toBeNull();
    expect(categoryOf(null, th)).toBeNull();
  });

  test("forecast_category fires on the peak, stale and missing inputs give cannot_assess, the tidal noise floor holds", () => {
    const t = Date.parse("2026-09-30T20:00:00Z");
    const forecast = { issuedAt: t - 4 * HOUR, source: "nwps-live", evidenceId: "forecast:MCGL1:1", points: [{ validAt: t + 6 * HOUR, stageFt: 3.5 }, { validAt: t + 48 * HOUR, stageFt: 4.0 }] };
    const flagged = review({ site: "MCGL1", asOf: t, tidal: true, thresholds: th, observation: { observedAt: t - HOUR, stageFt: 3.4, evidenceId: "reading:MCGL1:stage_m:1:measured" }, forecast, alerts: [] });
    expect(flagged.status).toBe("review");
    expect(flagged.reasons.map((r) => r.rule)).toEqual(["forecast_category"]);
    expect(flagged.reasons[0]).toMatchObject({ value: 4, threshold: 4, evidenceIds: ["forecast:MCGL1:1"] });
    expect(flagged.categoryPeak).toBe("action");
    expect(flagged.categoryNow).toBe("none");
    const quiet = review({ ...{ site: "MCGL1", asOf: t, tidal: true, thresholds: th, alerts: [] }, observation: { observedAt: t - HOUR, stageFt: 3.4, evidenceId: "r" }, forecast: { ...forecast, points: [{ validAt: t + 6 * HOUR, stageFt: 3.5 }] } });
    expect(quiet.status).toBe("ok");
    // A 2.5 ft rise flags a river gauge but not tidal Morgan City (3 ft floor).
    const rise = (tidal: boolean) => review({ site: tidal ? "MCGL1" : "SMML1", asOf: t, tidal, thresholds: th, observation: { observedAt: t - HOUR, stageFt: 3.5, evidenceId: "a" }, observationDayAgo: { observedAt: t - 25 * HOUR, stageFt: 1.0, evidenceId: "b" }, forecast: null, alerts: [] });
    expect(rise(false).reasons.map((r) => r.rule)).toContain("stage_rise");
    expect(rise(true).reasons.map((r) => r.rule)).not.toContain("stage_rise");
    expect(rise(true).change24hFt).toBe(2.5);
    const stale = review({ site: "AEXL1", asOf: t, thresholds: th, observation: { observedAt: t - HOUR, stageFt: 3, evidenceId: "a" }, forecast: { ...forecast, issuedAt: t - 40 * HOUR, points: [{ validAt: t + HOUR, stageFt: 3 }] }, alerts: [] });
    expect(stale.status).toBe("cannot_assess");
    expect(stale.reasons[0]).toMatchObject({ rule: "stale_input", threshold: 36 });
    const missing = review({ site: "X", asOf: t, thresholds: th, observation: null, forecast: null, alerts: [] });
    expect(missing.status).toBe("cannot_assess");
    expect(missing.reasons.map((r) => r.value)).toEqual(["observation", "forecast"]);
    const alert = review({ site: "MCGL1", asOf: t, thresholds: th, observation: { observedAt: t - HOUR, stageFt: 3.4, evidenceId: "a" }, forecast: { ...forecast, points: [{ validAt: t + HOUR, stageFt: 3.4 }] }, alerts: [{ id: "A1", event: "Flood Advisory", evidenceId: "alert:A1" }] });
    expect(alert.reasons.map((r) => r.rule)).toEqual(["active_alert"]);
    for (const r of [flagged, quiet, stale, missing, alert]) expect(JSON.stringify(r)).not.toMatch(/"(risk|probability|catch|abundance|safe)"/);
  });

  test("the datum trap: a USGS stage is never categorised (only the NWPS observation reaches the rule)", () => {
    // KRZL1: USGS 1.47 ft vs NWPS 3.92 ft against an action stage of 28 ft. The rule takes NWPS stage only; the
    // tools never pass a USGS value as `observation`. Both are far below 28 ft, and a USGS reading above a
    // threshold on its own datum would still not be compared: there is no USGS input to review().
    const krzl1 = { action: 28, minor: 29, moderate: 40, major: 43 };
    expect(categoryOf(3.92, krzl1)).toBe("none");
    const r = review({ site: "KRZL1", asOf: 0, thresholds: krzl1, observation: { observedAt: -HOUR, stageFt: 3.92, evidenceId: "reading:KRZL1:stage_m:0:measured" }, forecast: null, alerts: [] });
    expect(r.reasons.map((x) => x.rule)).toEqual(["missing_input"]);
    expect(review.length).toBe(1);
  });

  test("rapid change uses day-long spans; transitions report flips only", () => {
    const t0 = 0;
    const pts = [0, 6, 12, 18, 24, 30].map((h) => ({ validAt: t0 + h * HOUR, stageFt: h * 0.1 }));
    expect(forecastRiseRate(pts, t0)).toBe(2.4);
    const a: Review = { site: "S", asOf: "2026-01-01T00:00:00Z", status: "ok", reasons: [], stageFt: 1, observedAt: null, categoryNow: "none", categoryPeak: "none", peak: null, lowWater: false, change24hFt: 0, freshness: { observation: { state: "fresh", band: "green", newestAt: null, ageHours: 1 }, forecast: { state: "fresh", band: "green", newestAt: null, ageHours: 1 } } };
    const b: Review = { ...a, asOf: "2026-01-01T03:00:00Z", status: "review", reasons: [{ rule: "forecast_category", value: 4, threshold: 4, source: "x", evidenceIds: ["forecast:S:1"], text: "" }] };
    expect(transitions([a, b, { ...b, asOf: "2026-01-01T06:00:00Z" }]).map((t) => `${t.from}>${t.to}@${t.at}`)).toEqual(["ok:>review:forecast_category@2026-01-01T03:00:00Z"]);
  });
});

describe("carp tool: site_status", () => {
  test("carp tool: all eight sites now: Morgan City needs review (forecast peak at action stage), Alexandria cannot be assessed (stale forecast), Monroe is low water, every reason cites evidence", async () => {
    const out = await run("site_status", {});
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentReviewBoard", "AgentSiteStatus"]);
    expect(stub.requests[1]!.path).toBe("/v1/carp/graphql");
    const data = out.data as { counts: Record<string, number>; flagged: string[]; rows: Record<string, any>[]; engine: string };
    expect(data.flagged).toEqual(["MCGL1"]);
    expect(data.counts).toEqual({ review: 1, ok: 6, cannotAssess: 1, sites: 8 });
    expect(data.engine).toContain("mirrored");
    const mcgl1 = data.rows.find((r) => r.site === "MCGL1")!;
    expect(mcgl1.status).toBe("review");
    expect(mcgl1.needsReview).toBe(true);
    expect(mcgl1.categoryPeak).toBe("action");
    expect(mcgl1.peak).toMatchObject({ stageFt: 4 });
    expect(mcgl1.reasons[0]).toMatchObject({ rule: "forecast_category", value: 4, threshold: 4, cite: "[e:forecast:MCGL1:1790782320000]" });
    expect(mcgl1.feeds.nwps.state).toBe("fresh");
    expect(mcgl1.feeds.nwpsForecast.ageHours).toBeCloseTo(15.5, 0);
    expect(mcgl1.feeds.nws.lastCheckAt).toBe("2026-10-01T06:58:00Z");
    const aexl1 = data.rows.find((r) => r.site === "AEXL1")!;
    expect(aexl1.status).toBe("cannot_assess");
    expect(aexl1.reasons[0]).toMatchObject({ rule: "stale_input", threshold: 36 });
    expect(aexl1.reasons[0].value).toBeGreaterThan(36);
    expect(aexl1.feeds.nwpsForecast.state).toBe("stale");
    const mlul1 = data.rows.find((r) => r.site === "MLUL1")!;
    expect(mlul1.lowWater).toBe(true);
    expect(mlul1.status).toBe("ok");
    const btrl1 = data.rows.find((r) => r.site === "BTRL1")!;
    expect(btrl1.status).toBe("ok");
    expect(btrl1.categoryPeak).toBe("none");
    for (const row of data.rows) {
      expect(typeof row.stageFt === "number" || row.stageFt === null).toBe(true);
      expect(row.feeds.usgs.cite).toBe("[e:fetch:c-usgs-4412]");
    }
    expectEvidenceFormat(out, ["nwps"]);
    expect(out.evidence.map((e) => e.id)).toContain("forecast:MCGL1:1790782320000");
    expect(out.feeds.map((f) => f.source)).toEqual(["usgs", "nwps", "nws-alerts", "nws-forecast", "iem"]);
    expect((viewOf(out)!.result as TableView).rows).toHaveLength(8);
    expectView("site_status", out);
  });

  test("carp tool: asOf recomputes from what was known then: Morgan City was ok at 07:00 CDT on 30 Sep, before the 10:32 CDT issuance", async () => {
    const before = await run("site_status", { sites: ["Morgan City"], asOf: "2026-09-30T12:00:00Z" });
    expect((before.data as any).rows[0].status).toBe("ok");
    expect((before.data as any).asOf).toBe("2026-09-30T12:00:00.000Z");
    expect((before.data as any).asOfLocal).toBe("2026-09-30 07:00 CDT");
    const during = await run("site_status", { sites: ["MCGL1"], asOf: "2026-09-30T22:00:00Z" });
    const row = (during.data as any).rows[0];
    expect(row.status).toBe("review");
    expect(row.reasons.map((r: { rule: string }) => r.rule)).toEqual(["forecast_category", "active_alert"]);
    expect(row.activeAlerts).toBe(1);
    expect(stub.requests.some((r) => r.operationName === "AgentSiteStatus" && r.variables.asOf === "2026-09-30T22:00:00.000Z")).toBe(true);
    // A replay also carries the live state, so the answer can say what became known since then.
    const sinceThen = (during.data as any).sinceThen;
    expect(sinceThen.line).toMatch(/^Since then \(as of 2026-10-01 02:00 CDT\)/);
    expect(sinceThen.rows[0]).toMatchObject({ site: "MCGL1", statusThen: "review", statusNow: "review", changed: false });
    expect((during.data as any).asOfPhrase).toMatch(/^As of 2026-09-30 17:00 CDT, we knew:/);
    expect((during.data as any).rows[0].summary).toMatch(/^As of 2026-09-30 17:00 CDT, we knew: Morgan City \(MCGL1\) needs review because/);
  });

  test("carp tool: with C5's reviewBoard present the API engine answers in one POST", async () => {
    const c5 = startStub(0, { reviewFields: true });
    const prev = process.env.INVERSA_API_ORIGIN;
    process.env.INVERSA_API_ORIGIN = c5.origin;
    try {
      const out = await run("site_status", { sites: ["Morgan City", "Alexandria"] });
      expect(c5.requests.map((r) => r.operationName)).toEqual(["AgentReviewBoard"]);
      const data = out.data as { engine: string; rows: Record<string, any>[] };
      expect(data.engine).toContain("API");
      expect(data.rows.map((r) => [r.site, r.status])).toEqual([
        ["MCGL1", "review"],
        ["AEXL1", "cannot_assess"],
      ]);
      expect(data.rows[0]!.reasons[0]).toMatchObject({ rule: "forecast_category", value: 4 });
    } finally {
      process.env.INVERSA_API_ORIGIN = prev;
      c5.stop();
    }
  });
});

describe("carp tool: river_readings", () => {
  test("carp tool: USGS series and the NWPS observation per site, units and sources on every value, the Krotz Springs datum note, Monroe's two flows never blended", async () => {
    const out = await run("river_readings", { sites: ["Krotz Springs", "Monroe"], hours: 24 });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentRiverReadings"]);
    expect(stub.requests[0]!.variables.params).toEqual(["STAGE_M", "DISCHARGE_CFS"]);
    const rows = (out.data as { rows: Record<string, any>[] }).rows;
    const krzUsgs = rows.find((r) => r.site === "KRZL1" && r.source === "usgs" && r.param === "stage")!;
    expect(krzUsgs.unit).toBe("ft");
    expect(krzUsgs.latest.value).toBe(1.65);
    expect(krzUsgs.latest.metres).toBe(0.5);
    expect(krzUsgs.latest.cite).toBe("[e:reading:07381500:stage_m:1790834400000:measured]");
    expect(krzUsgs.datumNote).toMatch(/2\.45 ft below NWPS/);
    expect(krzUsgs.datumNote).toMatch(/Never compare this USGS stage with the NWPS flood thresholds/);
    expect(krzUsgs.change24h).toMatchObject({ value: expect.any(Number) });
    const krzNwps = rows.find((r) => r.site === "KRZL1" && r.source === "nwps")!;
    expect(krzNwps.latest.value).toBe(4.05);
    expect(krzNwps.datum).toMatch(/NWPS gauge datum/);
    expect(krzNwps.category).toBe("none");
    expect(krzNwps.thresholdsFt).toEqual({ action: 28, minor: 29, moderate: 40, major: 43 });
    const krzDischarge = rows.find((r) => r.site === "KRZL1" && r.param === "discharge")!;
    expect(krzDischarge.notMeasured).toBe(true);
    expect(krzDischarge.note).toMatch(/no discharge series/);
    const mluUsgs = rows.find((r) => r.site === "MLUL1" && r.source === "usgs" && r.param === "discharge")!;
    expect(mluUsgs.unit).toBe("cfs");
    expect(mluUsgs.latest.value).toBeGreaterThan(100);
    expect(mluUsgs.latest.kcfs).toBeCloseTo(mluUsgs.latest.value / 1000, 2);
    const mluNwps = rows.find((r) => r.site === "MLUL1" && r.source === "nwps")!;
    expect(mluNwps.flow).toMatchObject({ value: 8.11, unit: "kcfs", cfs: 8110 });
    expect(mluNwps.flow.source).toMatch(/nwps/);
    expect(mluNwps.flowNote).toMatch(/disagree 5 to 7 times/);
    expect((out.data as { units: string }).units).toMatch(/never|only/);
    expectEvidenceFormat(out, ["usgs", "nwps"]);
    expect(out.feeds.map((f) => f.source)).toEqual(["usgs", "nwps"]);
    const view = viewOf(out)!;
    expect((view.result as SeriesView).unit).toBe("ft");
    expectView("river_readings", out);
  });

  test("carp tool: a week at tidal Morgan City carries a 24 h mean and a tidal note; Butte La Rose discharge is not measured; a window ending at asOf uses the observation known then", async () => {
    const week = await run("river_readings", { sites: ["Morgan City"], hours: 168 });
    const stage = (week.data as any).rows.find((r: any) => r.source === "usgs" && r.param === "stage");
    expect(stage.mean24h).toBeGreaterThan(0);
    expect(stage.tidalNote).toMatch(/Tidal/);
    expect(stage.samples).toBeGreaterThan(100);
    expect((week.data as any).window.hours).toBe(168);
    const blr = await run("river_readings", { sites: ["Butte La Rose"], params: ["discharge"] });
    const row = (blr.data as any).rows.find((r: any) => r.source === "usgs");
    expect(row).toMatchObject({ notMeasured: true, latest: null });
    expect(row.note).toMatch(/stage only/);
    const past = await run("river_readings", { sites: ["Simmesport"], to: "2026-09-28T12:00:00Z", hours: 24, source: "nwps" });
    expect((past.data as any).rows[0].latest.at <= "2026-09-28T12:00:00Z").toBe(true);
    await expect(run("river_readings", { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" })).rejects.toThrow(/empty/);
  });
});

describe("carp tool: river_readings, stopped gauge", () => {
  test("carp tool: a window shorter than a day that misses a gauge which stopped reporting gives the newest known reading with its age, not 'no series'", async () => {
    const out = await run("river_readings", { sites: ["Bogalusa"], hours: 1, params: ["stage"], source: "usgs" });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentRiverReadings", "AgentRiverReadings"]);
    const row = (out.data as { rows: Record<string, any>[] }).rows.find((r) => r.site === "BXAL1" && r.source === "usgs" && r.param === "stage")!;
    expect(row.notMeasured).toBe(false);
    expect(row.latest.at).toBe("2026-10-01T03:15:00Z");
    expect(row.ageHours).toBeCloseTo(3.75, 1);
    expect(row.note).toMatch(/no USGS stage reading in the asked window .* newest known reading is .* hours old/);
    expect(out.evidence.map((e) => e.id)).toContain(row.latest.evidenceId);
  });
});

describe("carp tool: river_forecast", () => {
  test("carp tool: the issuance current now with provenance, issued time, peak and category against the thresholds, 6-hourly points, and previous=1 for the revision", async () => {
    const out = await run("river_forecast", { sites: ["Simmesport"], previous: 1 });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentForecasts"]);
    expect(stub.requests[0]!.variables.history).toBe(2);
    const row = (out.data as any).rows[0];
    expect(row.current).toMatchObject({ issuedAt: "2026-09-30T15:32:00Z", issuedLocal: "2026-09-30 10:32 CDT", provenance: "nwps-live", stale: false, horizonDays: 13.8 });
    expect(row.current.peak).toMatchObject({ stageFt: 13.7, category: "none" });
    expect(row.current.points[0]).toEqual({ at: "2026-09-30T18:00:00Z", stageFt: 8.1, flowKcfs: null, category: "none" });
    expect(row.thresholdsFt).toMatchObject({ action: 35, minor: 40, moderate: 44, major: 50 });
    expect(row.previousIssuances).toHaveLength(1);
    expect(row.previousIssuances[0]).toMatchObject({ issuedAt: "2026-09-29T16:11:00Z", provenance: "iem-archive" });
    expect(row.previousIssuances[0].versusCurrent.peakDeltaFt).toBeCloseTo(0.9, 1);
    expect(Date.parse(row.replayCoverageStart)).toBe(Date.parse("2026-09-24T14:30:00Z"));
    expect(row.liveCoverageStart).toBe("2026-09-29T12:00:00Z");
    expectEvidenceFormat(out, ["nwps", "iem"]);
    expect(out.evidence.map((e) => e.id)).toEqual(expect.arrayContaining(["forecast:SMML1:1790782320000", "forecast:SMML1:1790698260000"]));
    expect(out.feeds.map((f) => f.source)).toEqual(["nwps", "iem"]);
    expect((viewOf(out)!.result as SeriesView).series).toHaveLength(2);
    expectView("river_forecast", out);
  });

  test("carp tool: asOf picks the issuance known then (an archive copy before our first capture); Morgan City's peak reads action at or above 4 ft; Alexandria is stale now", async () => {
    const past = await run("river_forecast", { sites: ["Morgan City"], asOf: "2026-09-29T12:00:00Z" });
    const row = (past.data as any).rows[0];
    expect(row.current).toMatchObject({ issuedAt: "2026-09-28T14:28:00Z", provenance: "iem-archive" });
    expect(row.current.peak.category).toBe("none");
    expect(row.asOf).toBe("2026-09-29T12:00:00.000Z");
    const now = await run("river_forecast", { sites: ["MCGL1", "AEXL1"] });
    const [mcgl1, aexl1] = (now.data as any).rows;
    expect(mcgl1.current.peak).toMatchObject({ stageFt: 4, category: "action" });
    expect(aexl1.current).toMatchObject({ issuedAt: "2026-09-29T14:54:00Z", stale: true });
    expect(aexl1.current.ageHoursAtAsOf).toBeGreaterThan(36);
    const named = await run("river_forecast", { sites: ["Simmesport"], issuedAt: "2026-09-27T15:56:00Z" });
    expect((named.data as any).rows[0].current.issuedAt).toBe("2026-09-27T15:56:00Z");
  });
});

describe("carp tool: forecast_verify and review_history", () => {
  test("carp tool: forecast_verify scores the issuance current two days ago against NWPS observations, citing the issuance and the readings", async () => {
    const out = await run("forecast_verify", { sites: ["Morgan City"], daysAgo: 2 });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentForecasts", "AgentForecastVerify"]);
    const row = (out.data as any).rows[0];
    expect(row.issuedAt).toBe("2026-09-28T14:28:00Z");
    expect(row.provenance).toBe("iem-archive");
    expect(row.pairs.length).toBeGreaterThan(3);
    const pair = row.pairs.find((p: any) => typeof p.errorFt === "number");
    expect(typeof pair.forecastFt).toBe("number");
    expect(typeof pair.observedFt).toBe("number");
    expect(pair.cite).toMatch(/^\[e:reading:MCGL1:stage_m:\d+:measured\]$/);
    expect(Math.abs(pair.errorFt - (pair.forecastFt - pair.observedFt))).toBeLessThan(0.02);
    expect(row.meanAbsErrorFt).toBeGreaterThanOrEqual(0);
    expect(row.maxErrorFt).toBeGreaterThanOrEqual(row.meanAbsErrorFt);
    expect(row.pending).toBeGreaterThan(0);
    expect(row.note).toMatch(/forecast minus observed/);
    expectEvidenceFormat(out, ["iem", "nwps"]);
    expect(out.evidence.some((e) => e.id.startsWith("reading:MCGL1:stage_m:"))).toBe(true);
    expectView("forecast_verify", out);
  });

  test("carp tool: review_history gives the flips with rule and evidence: Morgan City ok, then review on the 30 Sep issuance, plus the alert while it was active", async () => {
    const out = await run("review_history", { site: "Morgan City" });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentReviewHistory", "AgentSiteStatusSeries"]);
    const data = out.data as any;
    expect(data.engine).toMatch(/every 3 h/);
    const flips = data.transitions.map((t: any) => `${t.from}>${t.to}`);
    expect(flips).toContain("ok:>review:forecast_category");
    expect(flips).toContain("review:forecast_category>review:forecast_category,active_alert");
    const flip = data.transitions.find((t: any) => t.to === "review:forecast_category");
    expect(flip.at).toBe("2026-09-30T16:00:00.000Z");
    expect(flip.rules[0]).toMatchObject({ rule: "forecast_category", issuedAt: "2026-09-30T15:32:00.000Z", cite: "[e:forecast:MCGL1:1790782320000]" });
    expectEvidenceFormat(out, ["nwps"]);
    expectView("review_history", out);
    await expect(run("review_history", { site: "Morgan City", from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" })).rejects.toThrow(/empty/);
  });
});

describe("carp tool: weather, alerts, sources, evidence, board, view", () => {
  test("carp tool: weather_forecast gives °F and mph per period from the gridpoint readings, the office update time, and a comma-free forecast:nws id", async () => {
    const out = await run("weather_forecast", { site: "Morgan City", periods: 4 });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentWeatherForecast"]);
    const data = out.data as any;
    expect(data).toMatchObject({ site: "MCGL1", office: "LCH", grid: "137,73", updateTime: "2026-10-01T06:50:35Z", fetchedAt: "2026-10-01T06:55:00Z" });
    expect(data.periods).toHaveLength(4);
    expect(data.periods[1]).toMatchObject({ temperatureF: 88, windMph: 10, windMs: 4.47 });
    expect(data.stored).toMatch(/precipitation chance and sky text are not ingested/);
    expect(data.cite).toBe("[e:forecast:nws:LCH/137x73:1790837435000]");
    expectEvidenceFormat(out, ["nws-forecast"]);
    expectView("weather_forecast", out);
    await expect(run("weather_forecast", { site: "Houston" })).rejects.toThrow(CARP.agent.refusal);
  });

  test("carp tool: alerts by site; an empty result is grounded by the check time and its fetch run; a past weekend finds the Pearl advisory", async () => {
    const none = await run("alerts", { site: "Morgan City" });
    expect(stub.requests[0]!.variables).toMatchObject({ at: CARP_FIXTURE_NOW.replace("Z", ".000Z") });
    const data = none.data as any;
    expect(data.rows).toEqual([]);
    expect(data.checkedAt).toBe("2026-10-01T06:58:00Z");
    expect(data.noActiveAlerts).toMatch(/\[e:fetch:c-nwsa-4418\]/);
    expect(none.evidence.map((e) => e.id)).toContain("fetch:c-nwsa-4418");
    const weekend = await run("alerts", { site: "Bogalusa", at: "2026-09-26T18:00:00Z" });
    expect((weekend.data as any).rows[0]).toMatchObject({ event: "Coastal Flood Advisory", evidenceId: "alert:NWS-LIX-CF-Y-0033" });
    expect(weekend.evidence[0]).toMatchObject({ kind: "alert", feed: "nws-alerts" });
    const during = await run("alerts", { site: "MCGL1", at: "2026-09-30T22:00:00Z" });
    expect((during.data as any).rows.map((r: any) => r.event)).toEqual(["Flood Advisory"]);
    // The advisory had not been seen at 19:00Z: as-of means first seen, not onset.
    expect((await run("alerts", { site: "MCGL1", at: "2026-09-30T19:00:00Z" })).count).toBe(0);
    expectView("alerts", none);
  });

  test("carp tool: source_info rows carry publisher, licence, cadence, rate limit, limits and health, cited as source:<feed>; 'nws' means both NWS feeds", async () => {
    const all = await run("source_info", {});
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentFeeds"]);
    const rows = (all.data as any).rows as Record<string, any>[];
    expect(rows.map((r) => r.feed)).toEqual(["usgs", "nwps", "nws-alerts", "nws-forecast", "iem", "nwws"]);
    const iem = rows.find((r) => r.feed === "iem")!;
    expect(iem.publisher).toMatch(/Iowa State/);
    expect(iem.licence).toMatch(/attribution/);
    expect(iem.limits.join(" ")).toMatch(/third-party copy/);
    expect(iem.health.state).toBe("nominal");
    expect(iem.cite).toBe("[e:source:iem]");
    const usgs = rows.find((r) => r.feed === "usgs")!;
    expect(usgs.licence).toMatch(/public domain/);
    expect(usgs.rateLimit).toMatch(/not published/);
    expect(usgs.limits.join(" ")).toMatch(/datum/);
    expect((all.data as any).boundary).toBe(CARP.copy.boundaryNote);
    expectEvidenceFormat(all, ["usgs", "iem"]);
    expect(all.evidence.filter((e) => e.kind === "source")).toHaveLength(6);
    const nws = await run("source_info", { feed: "nws" });
    expect((nws.data as any).rows.map((r: any) => r.feed)).toEqual(["nws-alerts", "nws-forecast"]);
    await expect(run("source_info", { feed: "ndbc" })).rejects.toThrow(/not a feed of this app/);
    expectView("source_info", all);
  });

  test("carp tool: evidence fetches one record with its source URL, publisher page, fetch time, lag and feed", async () => {
    const out = await run("evidence", { id: "reading:07381500:stage_m:1790834400000:measured" });
    expect(stub.requests.map((r) => r.operationName)).toEqual(["AgentEvidence"]);
    const data = out.data as any;
    expect(data.record).toMatchObject({ station: "07381500", value: 0.503, unit: expect.stringContaining("m") });
    expect(data.record.datum).toMatch(/2\.45 ft below the NWPS datum/);
    expect(data.sourceUrl).toMatch(/api\.waterdata\.usgs\.gov/);
    expect(data.sourcePageUrl).toMatch(/waterdata\.usgs\.gov\/monitoring-location\/07381500/);
    expect(data.fetchedAt).toBe("2026-10-01T06:20:00Z");
    expect(data.ingestLagSeconds).toBe(1200);
    expect(data.feed).toBe("usgs");
    expect(out.evidence[0]).toMatchObject({ id: "reading:07381500:stage_m:1790834400000:measured", kind: "reading", feed: "usgs" });
    const forecast = await run("evidence", { id: "forecast:MCGL1:1790782320000" });
    expect((forecast.data as any).record).toMatchObject({ source: "NWPS_LIVE", peakCategory: "ACTION" });
    await expect(run("evidence", { id: "nonsense" })).rejects.toThrow(/not an evidence id/);
    await expect(run("evidence", { id: "forecast:MCGL1:1" })).rejects.toThrow(/no evidence/);
  });

  test("carp tool: team_board reads missions and messages as human records, filtered by place and window, cited as mission:/message:", async () => {
    const all = await run("team_board", {});
    expect(stub.requests[0]!.variables).toEqual({ id: "carp:main" });
    const data = all.data as any;
    expect(data.missions.map((m: any) => m.site)).toEqual(["MCGL1", "SMML1", "KRZL1"]);
    expect(data.upcomingMissions).toBe(2);
    expect(data.missions[1]).toMatchObject({ title: "Simmesport gauge check and launch survey", status: "planned", startLocal: "2026-10-02 08:00 CDT", cite: "[e:mission:0199c1d3-0001-7000-8000-00000000a001]" });
    expect(data.messages).toHaveLength(3);
    expect(data.source).toMatch(/untrusted data/);
    expect(all.feeds).toEqual([]);
    for (const row of all.evidence) expect(["mission", "message"]).toContain(row.kind);
    const morgan = await run("team_board", { about: "Morgan City", hours: 24 });
    expect((morgan.data as any).missions).toEqual([]);
    expect((morgan.data as any).messages.map((m: any) => m.from)).toEqual(["Ops-Lead"]);
    expect((morgan.data as any).about).toEqual({ site: "MCGL1", name: "Atchafalaya River at Morgan City" });
    const missions = await run("team_board", { kind: "missions", about: "Krotz" });
    expect((missions.data as any).missions.map((m: any) => m.site)).toEqual(["KRZL1"]);
    expect((missions.data as any).messages).toEqual([]);
    expectView("team_board", all);
  });

  test("carp tool: notes takes a site; set_view takes a preset, a site, asOf and replay and emits the carp view state", async () => {
    const notes = await run("notes", { site: "Krotz Springs", hours: 24 });
    expect((notes.data as any).rows.map((r: any) => r.author)).toEqual(["Crew-K1"]);
    expect((notes.data as any).site).toBe("KRZL1");
    expectView("notes", notes);
    emitted.length = 0;
    await run("set_view", { preset: "atchafalaya", asOf: "2026-09-30T20:00:00Z" });
    expect(emitted).toEqual([{ type: "view", bbox: expect.objectContaining({ west: expect.any(Number) }), time: "2026-09-30T20:00:00.000Z", asOf: Date.parse("2026-09-30T20:00:00Z"), replay: true }]);
    const preset = emitted[0] as Extract<AgentStreamEvent, { type: "view" }>;
    expect((preset.bbox.west + preset.bbox.east) / 2).toBeCloseTo(-91.55, 1);
    emitted.length = 0;
    await run("set_view", { site: "Morgan City" });
    expect(emitted[0]).toMatchObject({ type: "view", site: "MCGL1", time: CARP_FIXTURE_NOW.replace("Z", ".000Z") });
    expect((emitted[0] as any).asOf).toBeUndefined();
    expect((emitted[0] as any).replay).toBeUndefined();
    emitted.length = 0;
    await run("set_view", { preset: "all-sites", time: "2026-09-27T18:00:00Z", replay: true });
    expect(emitted[0]).toMatchObject({ type: "view", time: "2026-09-27T18:00:00.000Z", replay: true });
    await expect(run("set_view", { site: "Orange, Texas" })).rejects.toThrow(CARP.agent.refusal);
    await expect(run("set_view", { preset: "everglades" })).rejects.toThrow(/no camera preset/);
    expect(stub.requests.filter((r) => r.operationName !== "AgentNotes")).toHaveLength(0);
  });

  test("carp tool: feed_state reports usgs, nwps, nws and iem for the carp app", async () => {
    const out = await run("feed_state", {});
    const sources = out.feeds.map((f) => f.source);
    for (const s of ["usgs", "nwps", "nws-alerts", "nws-forecast", "iem"]) expect(sources).toContain(s);
    expectView("feed_state", out);
  });
});
