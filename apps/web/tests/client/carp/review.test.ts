import { afterEach, describe, expect, test } from "bun:test";

import { briefing, conflictText, flowAvailability } from "client/carp/briefing";
import { fromC5, deriveReview, sortBoard, type ReviewInput } from "client/carp/review";
import { isUnknownField, loadC5Board, resetC5Probe } from "client/carp/data";
import { usgsSeries } from "client/carp/model";
import { GqlError } from "client/threads/api";

import { H, NOW, site, snap, status, usgsReadings, ZONE } from "./fixtures";

const krz = site("KRZL1");
const fresh = snap({ issuedAt: "2026-09-30T15:32:00Z", from: "2026-09-30T18:00:00Z", values: [3.6, 3.7, 3.9, 4.2] });
const base = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  site: krz,
  asOfMs: NOW,
  live: true,
  zone: ZONE,
  status: status(),
  forecast: fresh,
  previous: null,
  usgs: usgsSeries([], krz),
  ...over,
});

describe("derived review (until C5 serves siteReview)", () => {
  test("nothing fired and every input usable: no review needed", () => {
    const r = deriveReview(base());
    expect(r.status).toBe("ok");
    expect(r.reasons).toEqual([]);
    expect(r.origin).toBe("derived");
    expect(r.freshness).toBe("AGING");
  });

  test("forecast reaching action stage needs review, with value, threshold and issuance", () => {
    const mcg = site("MCGL1");
    const r = deriveReview(base({ site: mcg, status: status({ site: "MCGL1", thresholds: { actionFt: 4, minorFt: 6, moderateFt: 7, majorFt: 12 } }), forecast: { ...fresh, peakStageFt: 4.0, peakAt: "2026-10-08T12:00:00Z", peakCategory: "ACTION" } }));
    expect(r.status).toBe("review");
    expect(r.reasons[0]).toMatchObject({ rule: "forecast_category", kind: "review", value: 4, threshold: 4, issuedAt: fresh.issuedAt });
    expect(r.reasons[0]!.text).toBe("Forecast peak 4.0 ft on Oct 8 reaches action stage (4.0 ft).");
  });

  test("a stale observation is left out with its reason and the site cannot be assessed", () => {
    const r = deriveReview(base({ asOfMs: NOW + 9 * H, status: status({ observationFreshness: "STALE" }) }));
    expect(r.status).toBe("cannot_assess");
    expect(r.reasons.map((x) => x.rule)).toEqual(["stale_observation"]);
    expect(r.reasons[0]!.text).toContain("stale after 6 h");
  });

  test("a stale forecast (over 36 h) is dropped from the review with the reason stated", () => {
    const r = deriveReview(base({ asOfMs: Date.parse("2026-10-02T06:00:00Z"), status: status({ observationFreshness: "FRESH" }), forecast: { ...fresh, peakStageFt: 30 } }));
    expect(r.status).toBe("cannot_assess");
    expect(r.reasons.map((x) => x.rule)).toEqual(["stale_forecast"]);
  });

  test("nothing held at a past time: missing observation, forecast and thresholds, each said", () => {
    const r = deriveReview(base({ live: false, status: status({ observation: null, observationFreshness: "MISSING", thresholds: null }), forecast: null }));
    expect(r.status).toBe("cannot_assess");
    expect(r.reasons.map((x) => x.rule)).toEqual(["missing_observation", "missing_forecast", "no_thresholds"]);
    expect(r.freshness).toBe("MISSING");
  });

  test("past freshness ignores USGS readings (they carry no receipt time)", () => {
    const usgs = usgsSeries(usgsReadings(krz, [{ at: new Date(NOW - H).toISOString(), stageFt: 1.5 }]), krz);
    expect(deriveReview(base({ usgs, status: status({ observation: null, observationFreshness: "MISSING" }) })).freshness).toBe("FRESH");
    expect(deriveReview(base({ usgs, live: false, status: status({ observation: null, observationFreshness: "MISSING" }) })).freshness).toBe("MISSING");
  });

  test("stage change, forecast drift and alerts each fire review", () => {
    const usgs = usgsSeries(usgsReadings(krz, [{ at: new Date(NOW - 25 * H).toISOString(), stageFt: 1.0 }, { at: new Date(NOW - H).toISOString(), stageFt: 2.3 }]), krz);
    const previous = snap({ issuedAt: "2026-09-29T15:00:00Z", from: "2026-09-30T18:00:00Z", values: [3.6, 2.2] });
    const r = deriveReview(base({ usgs, previous, status: status({ activeAlerts: 2 }) }));
    expect(r.status).toBe("review");
    expect(r.reasons.map((x) => x.rule).sort()).toEqual(["forecast_drift", "nws_alerts", "stage_change"]);
    expect(r.reasons.find((x) => x.rule === "stage_change")!.text).toBe("Stage rose 1.30 ft in 24 h (USGS gauge height).");
  });

  test("board order: review first (more reasons first), then cannot assess, then fine", () => {
    const row = (lid: string, status: "review" | "ok" | "cannot_assess", n = 0) => ({
      site: site(lid),
      review: { site: lid, asOfMs: NOW, status, freshness: "FRESH" as const, origin: "derived" as const, reasons: Array.from({ length: n }, () => ({ rule: "x", kind: "review" as const, value: null, threshold: null, source: "", observedAt: null, issuedAt: null, link: null, text: "" })) },
    });
    const sorted = sortBoard([row("SMML1", "ok"), row("BXAL1", "cannot_assess"), row("MCGL1", "review", 1), row("BTRL1", "review", 2)]);
    expect(sorted.map((r) => r.site.lid)).toEqual(["BTRL1", "MCGL1", "BXAL1", "SMML1"]);
  });
});

describe("C5 adapter", () => {
  afterEach(() => resetC5Probe());

  test("fromC5 maps the service's rows (enum case, reasons) and rejects what does not fit", () => {
    const r = fromC5({ site: "mcgl1", status: "REVIEW", reasons: [{ rule: "forecast_category", value: 4, threshold: 4, source: "nwps", observedAt: null, issuedAt: "2026-09-30T15:32:00Z", link: "https://water.noaa.gov/gauges/mcgl1", text: "Forecast reaches action." }, { bad: true }] }, NOW, "FRESH");
    expect(r).toMatchObject({ site: "MCGL1", status: "review", origin: "c5", reasons: [{ rule: "forecast_category", kind: "review", text: "Forecast reaches action." }] });
    expect(fromC5({ site: "X", status: "maybe" }, NOW, "FRESH")).toBeNull();
    expect(fromC5(null, NOW, "FRESH")).toBeNull();
  });

  test("an API without reviewBoard is recognised, so the board derives statuses", async () => {
    expect(isUnknownField(new GqlError('Unknown field "reviewBoard" on type "Query".', []))).toBe(true);
    expect(isUnknownField(new GqlError("database is locked", []))).toBe(false);
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ errors: [{ message: 'Unknown field "reviewBoard" on type "Query".' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await loadC5Board(NOW)).toBeNull();
      expect(await loadC5Board(NOW)).toBeNull();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("briefing", () => {
  test("changed, expected and missing, with units, datums and sources", () => {
    const usgs = usgsSeries(usgsReadings(krz, [{ at: "2026-10-01T06:00:00Z", stageFt: 1.47 }]), krz);
    const previous = snap({ issuedAt: "2026-09-29T15:20:00Z", from: "2026-09-30T18:00:00Z", values: [3.4, 3.5] });
    const b = briefing({ site: krz, asOfMs: NOW, live: true, zone: ZONE, status: status(), forecast: fresh, previous, usgs, usgsWindow: usgs, alerts: [], alertsCheckedMs: NOW, weather: null, review: deriveReview(base()) });
    expect(b.changed[0]).toBe("NWPS stage 4.05 ft at Oct 1, 1:00 AM CDT (below action stage).");
    expect(b.changed[1]).toContain("Forecast issued Sep 30, 10:32 AM CDT (IEM archive copy of the NWS forecast)");
    expect(b.changed[1]).toContain("moved at most +0.2 ft");
    expect(b.expected[0]).toBe("Forecast peak 4.2 ft on Oct 1, 23.8 ft below action stage 28.0 ft (NWPS datum).");
    expect(b.expected).toContain("No active NWS alerts at the location (checked for Oct 1, 4:00 AM CDT).");
    expect(b.missing).toContain("Flow: not measured at this gauge (USGS).");
    expect(b.missing.some((m) => m.startsWith("24 h stage change: USGS history starts"))).toBe(true);
  });

  test("weather line: air, wind and the chance of precipitation with units, named as weather, not a stage forecast", () => {
    const usgs = usgsSeries(usgsReadings(krz, [{ at: "2026-10-01T06:00:00Z", stageFt: 1.47 }]), krz);
    const weather = { airC: { t: NOW, v: 22.8 }, windMs: { t: NOW, v: 4.47 }, popPct: { t: NOW, v: 84 } };
    const b = briefing({ site: krz, asOfMs: NOW, live: true, zone: ZONE, status: status(), forecast: fresh, previous: null, usgs, usgsWindow: usgs, alerts: [], alertsCheckedMs: NOW, weather, review: deriveReview(base()) });
    expect(b.expected).toContain("NWS gridpoint forecast near now: 23 °C air, wind 4.5 m/s, 84 % chance of precipitation (modelled weather, not a stage forecast).");
    const replay = briefing({ site: krz, asOfMs: NOW, live: false, zone: ZONE, status: status(), forecast: fresh, previous: null, usgs, usgsWindow: usgs, alerts: [], alertsCheckedMs: NOW, weather, review: deriveReview(base()) });
    expect(replay.expected.some((e) => e.includes("chance of precipitation"))).toBe(false);
  });

  test("flow: never measured, not held yet, or no readings at all are three different sentences", () => {
    const krzWindow = usgsSeries(usgsReadings(krz, [{ at: "2026-10-01T06:00:00Z", stageFt: 1.47 }]), krz);
    const mcg = site("MCGL1");
    const mcgWindow = usgsSeries(usgsReadings(mcg, [{ at: "2026-10-01T06:00:00Z", stageFt: 3.6, cfs: 26900 }]), mcg);
    const empty = usgsSeries([], mcg);
    expect(flowAvailability(krzWindow, krzWindow)).toBe("not_measured");
    expect(flowAvailability(mcgWindow, empty)).toBe("none_held");
    expect(flowAvailability(empty, empty)).toBe("no_readings");
    expect(flowAvailability(mcgWindow, mcgWindow)).toBe("held");
  });

  test("conflict chips explain, never average", () => {
    const stage = conflictText({ kind: "stage", usgsFt: 1.47, nwpsFt: 3.92, differenceFt: -2.45, atMs: NOW }, ZONE);
    expect(stage.title).toBe("Sources disagree: stage");
    expect(stage.detail).toContain("differ by 2.45 ft");
    expect(stage.detail).toContain("flood categories use NWPS stage only");
    const flow = conflictText({ kind: "flow", usgsCfs: 1430, nwpsCfs: 8180, ratio: 5.72, atMs: NOW }, ZONE);
    expect(flow.detail).toContain("1,430 cfs");
    expect(flow.detail).toContain("8,180 cfs");
    expect(flow.detail).toContain("5.7×");
  });
});
