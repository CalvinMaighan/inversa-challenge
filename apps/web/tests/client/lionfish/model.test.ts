import { describe, expect, test } from "bun:test";

import { spans, toReport } from "client/lionfish/data";
import { HEAT_LABEL_STEP, placeLabel } from "client/lionfish/draw";
import {
  areaCells,
  areaHeat,
  areaOf,
  baaWord,
  buoyVsSatellite,
  cellEvidenceId,
  componentText,
  countReports,
  DAY,
  feedChip,
  fieldPoints,
  groupHeat,
  heatAt,
  heatDisagrees,
  isLate,
  isSurveyApp,
  lagStats,
  parseCellEvidenceId,
  snapshotAt,
  windowReports,
} from "client/lionfish/model";
import { getApp } from "shared/apps";

import { AREAS, buoy, cell, crw, LIONFISH_APP, marine, NOW, report } from "./fixtures";

describe("lionfish overlay: heat labels and priority markers", () => {
  test("a heat label that would sit under a numbered marker steps up until clear; a clear one stays", () => {
    expect(placeLabel(100, 100, 120, [])).toEqual({ x: 100, y: 100 });
    expect(placeLabel(100, 100, 120, [{ x: 300, y: 100 }])).toEqual({ x: 100, y: 100 });
    // Marker right on the label: the label moves up one step (half the label, half the 26 px marker, a gap).
    expect(placeLabel(100, 100, 120, [{ x: 100, y: 100 }])).toEqual({ x: 100, y: 100 - HEAT_LABEL_STEP });
    // A marker above as well: the label goes below instead.
    expect(placeLabel(100, 100, 120, [{ x: 100, y: 100 }, { x: 120, y: 78 }])).toEqual({ x: 100, y: 100 + HEAT_LABEL_STEP });
    // Marker touching the label's edge only: still clear (26 px square plus 2 px gap).
    expect(placeLabel(100, 100, 120, [{ x: 100 + 60 + 15, y: 100 }])).toEqual({ x: 100, y: 100 });
  });
});

describe("lionfish model: app and areas", () => {
  test("Lionfish Watch is a survey app; carp and python are not", () => {
    expect(isSurveyApp(LIONFISH_APP)).toBe(true);
    expect(isSurveyApp(getApp("carp"))).toBe(false);
    expect(isSurveyApp(getApp("python"))).toBe(false);
  });

  test("four areas from the config, Belize and Colombia thin", () => {
    expect(AREAS.map((a) => a.code)).toEqual(["fl", "mx", "bz", "co"]);
    expect(AREAS.filter((a) => a.thin).map((a) => a.id)).toEqual(["belize", "co-caribbean"]);
    expect(areaOf(AREAS, 17.2, -87.9)?.id).toBe("belize");
    expect(areaOf(AREAS, 15.0, -80.0)).toBeNull();
  });
});

describe("lionfish model: reports", () => {
  const recent = report({ observed: "2026-09-20T15:00:00Z", submitted: "2026-09-21T01:00:00Z" });
  const lateUpload = report({ observed: "2026-07-01T15:00:00Z", submitted: "2026-09-25T00:00:00Z" });
  const copy = report({ observed: "2026-09-20T15:00:00Z", source: "gbif", submitted: null, duplicateOf: recent.id });
  const gbif = report({ observed: "2026-09-10T12:00:00Z", source: "gbif", submitted: null });
  const future = report({ observed: "2026-09-29T10:00:00Z", submitted: "2026-10-02T00:00:00Z" });
  const all = [recent, lateUpload, copy, gbif, future];

  test("observed basis: the window holds what was observed in it and known by then; a GBIF copy of an iNaturalist record is dropped, never drawn or counted", () => {
    const q = { basis: "observed" as const, atMs: NOW, days: 30 };
    expect(windowReports(all, q).map((r) => r.id).sort()).toEqual([recent.id, gbif.id].sort());
    expect(countReports(all, q)).toEqual({ independent: 2, copies: 0, late: 0, noSubmittedDate: 0 });
    // A period start replaces the trailing days: from the 15th, only the report of the 20th remains.
    expect(windowReports(all, { ...q, fromMs: Date.parse("2026-09-15T00:00:00Z") }).map((r) => r.id)).toEqual([recent.id]);
  });

  test("submitted basis counts uploads in the window; records without an upload date are reported apart, not guessed", () => {
    const c = countReports(all, { basis: "submitted", atMs: NOW, days: 30 });
    expect(c.independent).toBe(2); // recent, and the July dive uploaded in September
    expect(c.late).toBe(1);
    expect(c.noSubmittedDate).toBe(1); // the GBIF record
  });

  test("late filter keeps reports uploaded more than 30 days after the dive", () => {
    expect(isLate(lateUpload)).toBe(true);
    expect(isLate(recent)).toBe(false);
    expect(isLate(gbif)).toBe(false);
    expect(windowReports(all, { basis: "submitted", atMs: NOW, days: 30, lateOnly: true }).map((r) => r.id)).toEqual([lateUpload.id]);
  });

  test("known at: a report uploaded after the cursor is not in a past view", () => {
    expect(windowReports([future], { basis: "observed", atMs: NOW, days: 7 })).toEqual([]);
    expect(windowReports([future], { basis: "observed", atMs: Date.parse("2026-10-03T00:00:00Z"), days: 7 })).toHaveLength(1);
  });

  test("upload lag: median and late share over independent reports with dates", () => {
    const s = lagStats(all);
    expect(s.n).toBe(3);
    expect(s.lateCount).toBe(1);
    expect(s.medianDays).toBeCloseTo(2.6, 0);
    expect(lagStats([]).medianDays).toBeNull();
  });

  test("toReport keeps unknown upload dates unknown and finds the area", () => {
    const r = toReport(
      { id: "7", source: "gbif", extId: "x:1", lat: 20.5, lon: -87.1, accuracyM: null, observedAt: "2026-09-05T00:00:00Z", ingestedAt: "2026-10-01T09:00:00Z", quality: "RESEARCH", photoUrl: null, canonicalId: "3", conflict: false, taxon: { focus: true } },
      AREAS,
    );
    expect(r.submittedMs).toBeNull();
    expect(r.duplicateOf).toBe("3");
    expect(r.areaId).toBe("mx-caribbean");
  });

  test("spans cut a 90-day load into windows the API accepts", () => {
    const s = spans(NOW - 90 * DAY, NOW);
    expect(s).toHaveLength(3);
    expect(s.every((x) => x.toMs - x.fromMs <= 30 * DAY)).toBe(true);
    expect(s.at(-1)!.fromMs).toBe(NOW - 90 * DAY);
  });
});

describe("lionfish model: reef heat stress", () => {
  const rows = [
    ...crw("222", 24.525, -81.375, "2026-09-28", { sst: 30.0, anomaly: 1.5, dhw: 13.5, baa: 1 }),
    ...crw("222", 24.525, -81.375, "2026-09-29", { sst: 30.04, anomaly: 1.52, dhw: 13.65, baa: 1 }),
    ...crw("223", 24.575, -81.375, "2026-09-29", { sst: null as unknown as number, dhw: null, baa: null }),
    ...crw("500", 18.575, -87.325, "2026-09-29", { sst: 29.88, anomaly: 1.24, dhw: 7.85, baa: 3 }),
  ];
  const pixels = groupHeat(rows, AREAS);

  test("pixels group by station with one entry per product day; flagged values are null", () => {
    expect(pixels).toHaveLength(3);
    const looe = pixels.find((p) => p.station === "222")!;
    expect(looe.days.map((d) => d.dhw)).toEqual([13.5, 13.65]);
    expect(looe.areaId).toBe("fl-keys");
    expect(pixels.find((p) => p.station === "223")!.days[0]!.dhw).toBeNull();
  });

  test("heat at a time: ok within 72 h, stale after, missing before the first product or when values are missing", () => {
    const looe = pixels.find((p) => p.station === "222")!;
    expect(heatAt(looe, NOW).state).toBe("ok");
    expect(heatAt(looe, NOW).day?.dhw).toBe(13.65);
    expect(heatAt(looe, Date.parse("2026-10-03T00:00:00Z")).state).toBe("stale");
    expect(heatAt(looe, Date.parse("2026-09-20T00:00:00Z")).state).toBe("missing");
    expect(heatAt(pixels.find((p) => p.station === "223")!, NOW).state).toBe("missing");
  });

  test("Florida's DHW 13.65 with BAA 1 disagree; Mexico's DHW 7.85 with alert level 1 agree", () => {
    expect(heatDisagrees({ dhw: 13.65, baa: 1 })).toBe(true);
    expect(heatDisagrees({ dhw: 7.85, baa: 3 })).toBe(false);
    expect(heatDisagrees({ dhw: 0.5, baa: 3 })).toBe(true);
    expect(heatDisagrees({ dhw: null, baa: 1 })).toBe(false);
    const fl = areaHeat(pixels, "fl-keys", NOW);
    expect(fl).toMatchObject({ pixels: 2, ok: 1, missing: 1, maxDhw: 13.65, maxBaa: 1, disagree: true });
    expect(areaHeat(pixels, "belize", NOW)).toMatchObject({ pixels: 0, maxDhw: null });
  });

  test("BAA words, including CoralTemp v3.1's higher alert levels", () => {
    expect(baaWord(1)).toBe("Bleaching watch");
    expect(baaWord(3)).toBe("Alert level 1");
    expect(baaWord(7)).toBe("Alert level 5");
    expect(baaWord(null)).toBe("unknown");
  });

  test("buoy against satellite: nearest pair, never blended, disagreement at 0.5 °C", () => {
    const b = [buoy("39", 24.628, -81.109, "2026-10-01T06:00:00Z", 29.2), buoy("38", 24.456, -81.877, "2026-10-01T06:00:00Z", null, "SST_C")];
    const pair = buoyVsSatellite(b, pixels, NOW)!;
    expect(pair.buoy.station).toBe("39");
    expect(pair.satellite.valueC).toBe(30.04);
    expect(pair.diffC).toBeCloseTo(-0.84, 2);
    expect(pair.disagree).toBe(true);
    expect(buoyVsSatellite([buoy("39", 24.628, -81.109, "2026-10-01T06:00:00Z", 29.9)], pixels, NOW)!.disagree).toBe(false);
    expect(buoyVsSatellite(b, pixels, Date.parse("2026-09-20T00:00:00Z"))).toBeNull();
  });
});

describe("lionfish model: field window and priority", () => {
  test("field points: calm hours under 1.2 m, highest wave and current over the horizon", () => {
    const pts = fieldPoints([...marine("m1", 24.5, -81.5, NOW, [0.8, 1.0, 1.4, 0.9], 0.4), ...marine("m2", 20.5, -87.0, NOW - 5 * DAY, [3])], AREAS, NOW, 72);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ station: "m1", calmHours: 3, hours: 4, waveMaxM: 1.4, currentMaxMs: 0.4, areaId: "fl-keys" });
  });

  test("ranked places: neighbouring cells collapse to the best one; thin cells stay, labelled", () => {
    const snap = {
      atMs: NOW,
      cells: [cell("315:248", "fl-keys", 26.785, -80.045, 0.62), cell("315:247", "fl-keys", 26.775, -80.045, 0.59), cell("179:24", "fl-keys", 24.545, -81.405, 0.39), cell("55:123", "belize", 17.235, -87.945, 0.67, { thin: true })],
    };
    expect(areaCells(snap, "fl-keys").map((c) => c.cell)).toEqual(["fl-keys:315:248", "fl-keys:179:24"]);
    expect(areaCells(snap, "belize")[0]!.thin).toBe(true);
    expect(areaCells(null, "fl-keys")).toEqual([]);
  });

  test("snapshot at a time is the newest at or before it", () => {
    const s = [{ atMs: NOW - 2 * DAY, cells: [] }, { atMs: NOW - DAY, cells: [] }, { atMs: NOW, cells: [] }];
    expect(snapshotAt(s, NOW - DAY - 1)?.atMs).toBe(NOW - 2 * DAY);
    expect(snapshotAt(s, NOW)?.atMs).toBe(NOW);
    expect(snapshotAt(s, NOW - 3 * DAY)).toBeNull();
  });

  test("cell evidence ids round-trip and refuse other hotspot ids", () => {
    const id = cellEvidenceId("lionfish", "fl-keys:315:248", NOW);
    expect(id).toBe(`hotspot:lionfish:fl-keys:315:248:${NOW}`);
    expect(parseCellEvidenceId(id)).toEqual({ species: "lionfish", cell: "fl-keys:315:248", atMs: NOW });
    expect(parseCellEvidenceId("hotspot:python:12:40:1790000000000")).toBeNull();
    expect(parseCellEvidenceId(null)).toBeNull();
  });

  test("component values read on their own 0..1 scale, never as a percent; unknown is a word", () => {
    expect(componentText({ value: 0.617, state: "OK" })).toBe("0.62");
    expect(componentText({ value: null, state: "UNKNOWN" })).toBe("unknown");
    expect(componentText({ value: 0.3, state: "STALE" })).toBe("stale");
    expect(componentText({ value: 0.5, state: "OK" })).not.toContain("%");
  });

  test("feed chips name the mode the adapter runs in and the state in words", () => {
    expect(feedChip({ source: "crw", mode: "POLL", state: "NOMINAL", newestObservedAt: null, lastFetchAt: null, lagSeconds: null, note: null })).toMatchObject({ mode: "poll", state: "on time", tone: "ok" });
    expect(feedChip({ source: "x", mode: "WEBHOOK", state: "STALE", newestObservedAt: null, lastFetchAt: null, lagSeconds: null, note: null })).toMatchObject({ mode: "webhook", state: "stale" });
    expect(feedChip({ source: "goes19-sst", mode: "PUSH", state: "DOWN", newestObservedAt: null, lastFetchAt: null, lagSeconds: null, note: null })).toMatchObject({ mode: "push", state: "down", tone: "danger" });
  });
});
