import { describe, expect, test } from "bun:test";

import { yRange } from "client/carp/chart";
import { cfs, ft, kcfs, localTime, signedFt, yesterdayAfternoon, zonedInstant } from "client/carp/format";
import {
  categoryOf,
  change24h,
  earlierIssuances,
  flowConflict,
  forecastAsOf,
  forecastDrift,
  forecastPeak,
  freshnessOfForecast,
  freshnessOfObservation,
  issuanceSpread,
  knowableAt,
  stageConflict,
  thresholdList,
  usgsSeries,
  weatherAt,
} from "client/carp/model";

import { H, NOW, site, SITES, snap, usgsReadings, ZONE } from "./fixtures";

describe("carp sites", () => {
  test("eight locations keyed by NWPS id, Morgan City marked tidal", () => {
    expect(SITES.map((s) => s.lid)).toEqual(["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"]);
    expect(SITES.filter((s) => s.tidal).map((s) => s.lid)).toEqual(["MCGL1"]);
  });
});

describe("what was knowable when", () => {
  const archive = snap({ issuedAt: "2026-09-30T15:32:00Z", source: "IEM_ARCHIVE", ingestedAt: "2026-10-01T07:01:00Z", values: [3.6] });
  const live = snap({ issuedAt: "2026-09-30T15:32:00Z", source: "NWPS_LIVE", ingestedAt: "2026-10-01T07:01:00Z", values: [3.6] });
  const older = snap({ issuedAt: "2026-09-29T15:20:00Z", values: [3.3] });
  const weather = snap({ issuedAt: "2026-10-01T06:50:00Z", source: "NWS_GRIDPOINT", product: "gridpoint" });

  test("an archive copy is knowable at issuance, a live capture when we stored it", () => {
    expect(knowableAt(archive)).toBe(Date.parse("2026-09-30T15:32:00Z"));
    expect(knowableAt(live)).toBe(Date.parse("2026-10-01T07:01:00Z"));
  });

  test("forecastAsOf: the latest river issuance knowable then, live capture over archive copy, never the gridpoint", () => {
    const all = [weather, live, archive, older];
    expect(forecastAsOf(all, NOW)).toBe(live);
    expect(forecastAsOf(all, Date.parse("2026-09-30T20:00:00Z"))).toBe(archive);
    expect(forecastAsOf(all, Date.parse("2026-09-30T12:00:00Z"))).toBe(older);
    expect(forecastAsOf(all, Date.parse("2026-09-20T00:00:00Z"))).toBeNull();
  });

  test("earlierIssuances lists distinct earlier issuance times, newest first", () => {
    expect(earlierIssuances([live, archive, older, weather], live, NOW)).toEqual([older]);
  });

  test("freshness bands: forecasts 24/36 h, observations 2/6 h, missing when absent", () => {
    expect(freshnessOfForecast(archive, Date.parse("2026-10-01T15:00:00Z"))).toBe("FRESH");
    expect(freshnessOfForecast(archive, Date.parse("2026-10-02T01:00:00Z"))).toBe("AGING");
    expect(freshnessOfForecast(archive, Date.parse("2026-10-02T04:00:00Z"))).toBe("STALE");
    expect(freshnessOfForecast(null, NOW)).toBe("MISSING");
    expect(freshnessOfObservation(NOW - H, NOW)).toBe("FRESH");
    expect(freshnessOfObservation(NOW - 5 * H, NOW)).toBe("AGING");
    expect(freshnessOfObservation(NOW - 7 * H, NOW)).toBe("STALE");
    expect(freshnessOfObservation(null, NOW)).toBe("MISSING");
  });
});

describe("forecast shape", () => {
  const prev = snap({ issuedAt: "2026-09-29T15:00:00Z", from: "2026-09-30T00:00:00Z", values: [3.0, 3.2, 3.4] });
  const cur = snap({ issuedAt: "2026-09-30T15:00:00Z", from: "2026-09-30T06:00:00Z", values: [3.4, 4.6, 5.0, 9.0] });

  test("drift compares shared valid times only, so a longer horizon is not counted as a move", () => {
    // Shared: 09-30 06Z (3.2 → 3.4) and 12Z (3.4 → 4.6). The 9.0 ft point has no earlier counterpart.
    expect(forecastDrift(cur, prev)).toEqual({ ft: expect.closeTo(1.2, 6), at: Date.parse("2026-09-30T12:00:00Z") });
    expect(forecastDrift(cur, null)).toBeNull();
  });

  test("peak from the API or from the points", () => {
    expect(forecastPeak(cur)).toEqual({ ft: 9, at: Date.parse("2026-10-01T00:00:00Z"), category: null });
    expect(forecastPeak({ ...cur, peakStageFt: 4, peakAt: "2026-10-03T00:00:00Z", peakCategory: "ACTION" })?.category).toBe("ACTION");
  });

  test("issuance spread is the low and high of the last issuances at each valid time", () => {
    expect(issuanceSpread(cur, [prev], 3).slice(0, 2)).toEqual([
      { t: Date.parse("2026-09-30T06:00:00Z"), lo: 3.2, hi: 3.4 },
      { t: Date.parse("2026-09-30T12:00:00Z"), lo: 3.4, hi: 4.6 },
    ]);
  });
});

describe("observations by source", () => {
  const krz = site("KRZL1");
  const readings = usgsReadings(krz, [
    { at: "2026-09-30T06:00:00Z", stageFt: 1.2 },
    { at: "2026-10-01T06:00:00Z", stageFt: 1.47 },
  ]);

  test("USGS gauge height comes back in feet; the station is the nearest usgs gauge", () => {
    const s = usgsSeries(readings, krz);
    expect(s.stationId).toBe("6");
    expect(s.stageFt.at(-1)!.v).toBeCloseTo(1.47, 6);
    expect(s.dischargeCfs).toEqual([]);
    expect(usgsSeries(readings, site("BXAL1")).stationId).toBeNull();
  });

  test("24 h change from the reading a day earlier; null without one; tidal sites use 24 h means", () => {
    const s = usgsSeries(readings, krz);
    expect(change24h(s.stageFt, Date.parse("2026-10-01T07:00:00Z"))?.ft).toBeCloseTo(0.27, 6);
    expect(change24h(s.stageFt.slice(1), Date.parse("2026-10-01T07:00:00Z"))).toBeNull();
    expect(change24h(s.stageFt, Date.parse("2026-10-01T07:00:00Z"), true)).toBeNull();
  });

  test("KRZL1: USGS 1.47 ft against NWPS 3.92 ft is a datum conflict; Monroe flows 5.7x apart are a flow conflict", () => {
    const s = usgsSeries(readings, krz);
    const c = stageConflict(s.stageFt, { t: Date.parse("2026-10-01T06:00:00Z"), ft: 3.92 });
    expect(c).toMatchObject({ kind: "stage", nwpsFt: 3.92 });
    expect(c?.kind === "stage" && c.differenceFt).toBeCloseTo(-2.45, 6);
    expect(stageConflict(s.stageFt, { t: Date.parse("2026-10-01T06:00:00Z"), ft: 1.6 })).toBeNull();
    const flow = flowConflict([{ t: NOW, v: 1430 }], { t: NOW, kcfs: 8.18 });
    expect(flow?.kind === "flow" && flow.ratio).toBeCloseTo(5.72, 2);
    expect(flowConflict([{ t: NOW, v: 8000 }], { t: NOW, kcfs: 8.18 })).toBeNull();
  });

  test("gridpoint weather near the time, modelled, within 6 h", () => {
    const station = { id: "10", source: "nws-forecast", lat: krz.lat, lon: krz.lon };
    const w = weatherAt([{ param: "AIR_C", value: 22.8, observedAt: "2026-10-01T07:00:00Z", origin: "MODELED", station }], krz, NOW);
    expect(w.airC?.v).toBe(22.8);
    expect(w.windMs).toBeNull();
  });
});

describe("thresholds and categories (NWPS stage only)", () => {
  test("-9999 and nulls are not thresholds; categories are 'at or above'", () => {
    const t = { actionFt: 4, minorFt: 6, moderateFt: null, majorFt: -9999 };
    expect(thresholdList(t).map((x) => x.ft)).toEqual([4, 6]);
    expect(categoryOf(3.99, t)).toBe("NONE");
    expect(categoryOf(4, t)).toBe("ACTION");
    expect(categoryOf(6.5, t)).toBe("MINOR");
    expect(categoryOf(4, null)).toBeNull();
  });

  test("chart range keeps a nearby threshold and lists a far one instead of flattening the river", () => {
    const series = [{ t: 0, v: 3.5 }, { t: 1, v: 4.2 }];
    const near = yRange({ usgsStage: series, nwpsObserved: [], forecast: [], spread: [], thresholds: [{ label: "Action", ft: 4 }] });
    expect(near.lo).toBeLessThan(3.5);
    expect(near.offChart).toEqual([]);
    const far = yRange({ usgsStage: series, nwpsObserved: [], forecast: [], spread: [], thresholds: [{ label: "Action", ft: 28 }] });
    expect(far.hi).toBeLessThan(10);
    expect(far.offChart[0]).toMatchObject({ label: "Action", ft: 28 });
  });
});

describe("carp formatting", () => {
  test("units are always written", () => {
    expect(ft(4.051)).toBe("4.05 ft");
    expect(ft(null)).toBe("—");
    expect(signedFt(-0.09)).toBe("−0.09 ft");
    expect(cfs(118000)).toBe("118,000 cfs");
    expect(kcfs(8.18)).toBe("8.18 kcfs (8,180 cfs)");
  });

  test("Central time with its zone; yesterday afternoon is 3 PM local the day before", () => {
    expect(localTime(Date.parse("2026-09-30T20:00:00Z"), ZONE)).toBe("Sep 30, 3:00 PM CDT");
    expect(yesterdayAfternoon(NOW, ZONE)).toBe(Date.parse("2026-09-30T20:00:00Z"));
    // 01:00 UTC on Oct 1 is still Sep 30 in Louisiana: yesterday is Sep 29.
    expect(yesterdayAfternoon(Date.parse("2026-10-01T01:00:00Z"), ZONE)).toBe(Date.parse("2026-09-29T20:00:00Z"));
    // Standard time in winter.
    expect(zonedInstant(2026, 1, 15, 15, ZONE)).toBe(Date.parse("2026-01-15T21:00:00Z"));
  });
});
