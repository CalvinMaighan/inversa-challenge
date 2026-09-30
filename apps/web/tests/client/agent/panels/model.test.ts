import { describe, expect, test } from "bun:test";

import {
  EXPAND_WIDTH,
  altitudeForBox,
  covers,
  expandedPanelRect,
  formatCell,
  formatTime,
  linePath,
  nextSort,
  niceTicks,
  panelsFromToolEnd,
  panelSummary,
  primaryPanelIndex,
  readoutAt,
  seriesDomain,
  sortRows,
  timeForInstant,
  timeTicks,
  viewTime,
  visibleRows,
  VISIBLE_TRAIL_MS,
  type Plot,
} from "client/agent/panels/model";
import { conditionsViews, sightingsView, type ReadingRow, type SightingRow } from "@/server/agent/tools/views";
import type { SeriesView, TableColumn, TableView } from "shared/agent/results";

const H = 3_600_000;
const HOMESTEAD = { west: -80.56, south: 25.38, east: -80.33, north: 25.56 };

function sighting(id: number, observedAt: string, extra: Partial<SightingRow> = {}): SightingRow {
  return {
    evidenceId: `sighting:${id}`,
    species: "Green iguana",
    source: "inat",
    quality: "research",
    observedAt,
    lat: 25.5,
    lon: -80.45,
    duplicateOf: null,
    idConflict: false,
    ...extra,
  };
}

function reading(station: string, t: number, value: number | null, extra: Partial<ReadingRow> = {}): ReadingRow {
  return {
    evidenceId: `reading:${station}:stage_m:${t}:measured`,
    stationId: station,
    station: `Gauge ${station}`,
    source: "usgs",
    lat: 25.33,
    lon: -80.52,
    param: "stage_m",
    value,
    flag: value === null ? "suspect" : "ok",
    origin: "measured",
    observedAt: new Date(t).toISOString(),
    ...extra,
  };
}

const tableOf = (rows: SightingRow[]) => sightingsView(rows, HOMESTEAD, "Iguana sightings").result as TableView;

describe("data panels", () => {
  test("panel: tool_end data becomes result-then-more panels; anything else none", () => {
    const t0 = Date.parse("2026-09-30T18:00:00Z");
    const readings = [0, 1, 2].map((i) => reading("7", t0 + i * H, 0.8 + i / 100));
    const data = { count: 3, evidence: [], feeds: [], ...conditionsViews(readings, [readings[2]!], HOMESTEAD, ["stage_m"], "") };
    const panels = panelsFromToolEnd("call-1", "conditions", data);
    expect(panels.map((p) => [p.key, p.view.view])).toEqual([
      ["call-1:0", "series"],
      ["call-1:1", "table"],
    ]);
    expect(panels[0]!.bbox).toEqual(HOMESTEAD);
    expect(panels[1]!.highlight).toEqual(["reading:7:stage_m:" + (t0 + 2 * H) + ":measured"]);
    expect(panelsFromToolEnd("x", "geocode", { name: "Homestead" })).toEqual([]);
    expect(panelsFromToolEnd("x", "sightings", { result: { view: "pie" } })).toEqual([]);
    expect(panelsFromToolEnd("x", "sightings", null)).toEqual([]);
    // A malformed bbox is dropped, not trusted.
    const bad = panelsFromToolEnd("x", "sightings", { result: tableOf([]), bbox: { west: 1, south: 1, east: 0, north: 2 } });
    expect(bad[0]!.bbox).toBeUndefined();
  });

  test("panel table: sorting by time, text and number, nulls last, stable, header cycle", () => {
    const table = tableOf([
      sighting(1, "2026-09-02T18:09:00Z", { species: "Green iguana", lat: 25.55 }),
      sighting(2, "2026-09-09T04:27:00Z", { species: "Burmese python", lat: 25.42 }),
      sighting(3, "2026-09-08T16:35:00Z", { species: "burmese python", lat: 25.41, duplicateOf: "sighting:2" }),
    ]);
    const col = (key: string) => table.columns.find((c) => c.key === key)!;
    const ids = (rows: TableView["rows"]) => rows.map((r) => r.evidenceId);
    expect(ids(sortRows(table.rows, table.columns, null))).toEqual(["sighting:1", "sighting:2", "sighting:3"]);
    expect(ids(sortRows(table.rows, table.columns, { key: "time", dir: "desc" }))).toEqual(["sighting:2", "sighting:3", "sighting:1"]);
    expect(ids(sortRows(table.rows, table.columns, { key: "time", dir: "asc" }))).toEqual(["sighting:1", "sighting:3", "sighting:2"]);
    // Case-insensitive text; equal keys keep server order.
    expect(ids(sortRows(table.rows, table.columns, { key: "species", dir: "asc" }))).toEqual(["sighting:2", "sighting:3", "sighting:1"]);
    expect(ids(sortRows(table.rows, table.columns, { key: "lat", dir: "asc" }))).toEqual(["sighting:3", "sighting:2", "sighting:1"]);
    // Empty "Duplicate of" cells sink whichever way the column sorts.
    expect(ids(sortRows(table.rows, table.columns, { key: "dup", dir: "asc" }))[0]).toBe("sighting:3");
    expect(ids(sortRows(table.rows, table.columns, { key: "dup", dir: "desc" }))[0]).toBe("sighting:3");
    expect(nextSort(null, col("time"))).toEqual({ key: "time", dir: "desc" });
    expect(nextSort(null, col("species"))).toEqual({ key: "species", dir: "asc" });
    expect(nextSort({ key: "species", dir: "asc" }, col("species"))).toEqual({ key: "species", dir: "desc" });
  });

  test("panel table: 50 rows until show-all, with the hidden count", () => {
    const rows = Array.from({ length: 137 }, (_, i) => i);
    expect(visibleRows(rows, false)).toEqual({ rows: rows.slice(0, 50), hidden: 87 });
    expect(visibleRows(rows, true)).toEqual({ rows, hidden: 0 });
    expect(visibleRows(rows.slice(0, 50), false).hidden).toBe(0);
    const many = sightingsView(
      Array.from({ length: 620 }, (_, i) => sighting(i, "2026-09-02T18:09:00Z")),
      HOMESTEAD,
      "t",
    );
    // The server caps what it sends at 500 and says how many there were.
    expect((many.result as TableView).rows).toHaveLength(500);
    expect((many.result as TableView).total).toBe(620);
    expect(panelSummary(many.result!)).toBe("620 rows");
    expect(many.highlight).toHaveLength(50);
  });

  test("panel table: cells format by kind", () => {
    const time: TableColumn = { key: "time", label: "Observed", kind: "time" };
    const lat: TableColumn = { key: "lat", label: "Lat", unit: "°", kind: "number" };
    const value: TableColumn = { key: "value", label: "Value", kind: "number" };
    expect(formatCell("2026-09-02T18:09:31Z", time)).toBe("09-02 18:09Z");
    expect(formatCell(25.5541483333, lat)).toBe("25.554");
    expect(formatCell(0.80772, value)).toBe("0.81");
    expect(formatCell(24.62, value)).toBe("24.6");
    expect(formatCell(1203.4, value)).toBe("1203");
    expect(formatCell(null, value)).toBe("—");
    expect(formatTime("not a time")).toBe("not a time");
  });

  test("panel series: domain ignores nulls and pads a flat line", () => {
    const view: SeriesView = {
      view: "series",
      title: "t",
      unit: "m",
      series: [{ label: "a", points: [[0, 1], [H, null], [2 * H, 1]] }],
    };
    const d = seriesDomain(view)!;
    expect(d.t0).toBe(0);
    expect(d.t1).toBe(2 * H);
    expect(d.v0).toBeLessThan(1);
    expect(d.v1).toBeGreaterThan(1);
    expect(seriesDomain({ series: [{ label: "x", points: [[0, null]] }] })).toBeNull();
    // One sample still gets a time span to draw in.
    const single = seriesDomain({ series: [{ label: "x", points: [[5 * H, 2]] }] })!;
    expect(single.t1 - single.t0).toBe(H);
  });

  test("panel series: paths break at null gaps and lone points become dots, on scale", () => {
    const plot: Plot = { width: 320, height: 150, left: 40, right: 8, top: 14, bottom: 20 };
    const d = { t0: 0, t1: 4 * H, v0: 0, v1: 10 };
    const { d: path, dots } = linePath(
      [
        [0, 0],
        [H, 10],
        [2 * H, null],
        [3 * H, 5],
        [3.5 * H, null],
        [4 * H, 0],
      ],
      d,
      plot,
    );
    // Two dashes: 0h–1h, then nothing, then two lone samples as dots.
    expect(path).toBe("M40.0 130.0L108.0 14.0");
    expect(dots).toEqual([
      [244, 72],
      [312, 130],
    ]);
    expect(path.match(/M/g)).toHaveLength(1);
  });

  test("panel series: nice value ticks and whole-step time ticks", () => {
    expect(niceTicks(0.8, 1.25, 4)).toEqual([0.8, 1, 1.2]);
    expect(niceTicks(0.8, 1.25, 6)).toEqual([0.8, 0.9, 1, 1.1, 1.2]);
    expect(niceTicks(7.2, 12.3, 4)).toEqual([8, 10, 12]);
    expect(niceTicks(3, 3)).toEqual([3]);
    const t0 = Date.parse("2026-09-30T17:40:00Z");
    const ticks = timeTicks(t0, t0 + 3 * H, 3);
    expect(ticks.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(["18:00", "19:00", "20:00"]);
  });

  test("panel series: readout takes each line's nearest non-null sample", () => {
    const view = {
      series: [
        { label: "a", points: [[0, 1], [H, null], [2 * H, 3]] as [number, number | null][] },
        { label: "b", points: [[0, null]] as [number, number | null][] },
      ],
    };
    expect(readoutAt(view, 0.9 * H)).toEqual([{ label: "a", t: 0, value: 1 }]);
    expect(readoutAt(view, 1.6 * H)).toEqual([{ label: "a", t: 2 * H, value: 3 }]);
  });

  test("panel expanded: docked left of the card, never over the globe centre, a sheet on phones", () => {
    const cardAt = (vw: number, vh: number) => ({ top: vh - 12 - 480, left: vw - 12 - 360, width: 360, height: 480 });
    for (const [vw, vh] of [
      [1280, 800],
      [1440, 900],
      [1920, 1080],
      [2560, 1440],
      [1024, 768],
    ] as const) {
      const card = cardAt(vw, vh);
      const r = expandedPanelRect(card, { width: vw, height: vh });
      expect(r.sheet).toBe(false);
      expect(covers(r, vw / 2, vh / 2)).toBe(false);
      expect(r.left + r.width).toBe(card.left - 12);
      expect(r.top + r.height).toBe(card.top + card.height);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.width).toBeLessThanOrEqual(EXPAND_WIDTH);
    }
    // 1280×800: the full 640 fits only below the centre line.
    expect(expandedPanelRect(cardAt(1280, 800), { width: 1280, height: 800 })).toEqual({ top: 440, left: 256, width: 640, height: 348, sheet: false });
    // 2560×1440: room for 640 beside the centre, at full height.
    const wide = expandedPanelRect(cardAt(2560, 1440), { width: 2560, height: 1440 });
    expect(wide).toMatchObject({ width: 640, height: 600 });
    expect(expandedPanelRect({ top: 332, left: 0, width: 375, height: 480 }, { width: 375, height: 812 })).toEqual({
      top: 0,
      left: 0,
      width: 375,
      height: 812,
      sheet: true,
    });
  });

  test("panel primary: things on the map beat context; the latest call of a tool wins", () => {
    const table = tableOf([sighting(1, "2026-09-02T18:09:00Z")]);
    const t0 = Date.parse("2026-09-30T18:00:00Z");
    const rs = [reading("7", t0, 0.8), reading("7", t0 + H, 0.81)];
    const cond = { count: 2, evidence: [], feeds: [], ...conditionsViews(rs, [rs[1]!], HOMESTEAD, [], "") };
    const panels = [
      ...panelsFromToolEnd("c1", "conditions", cond),
      ...panelsFromToolEnd("s1", "sightings", { result: table }),
      ...panelsFromToolEnd("s2", "sightings", { result: table }),
      ...panelsFromToolEnd("f1", "feed_state", { result: { view: "feeds", title: "Feeds", feeds: [] } }),
    ];
    expect(panels[primaryPanelIndex(panels)]!.key).toBe("s2:0");
    expect(primaryPanelIndex(panels.slice(0, 2))).toBe(0);
    expect(primaryPanelIndex([])).toBe(-1);
  });

  test("panel time: each view's instant, and TIME moves only when the trail would miss it", () => {
    const table = tableOf([sighting(1, "2026-09-02T18:09:00Z"), sighting(2, "2026-08-31T10:00:00Z")]);
    expect(viewTime(table)).toBe(Date.parse("2026-09-02T18:09:00Z"));
    expect(viewTime({ view: "cells", title: "", species: "python", at: "2026-01-15T03:00:00Z", cells: [] })).toBe(Date.parse("2026-01-15T03:00:00Z"));
    expect(viewTime({ view: "explain", title: "", evidenceId: "hotspot:python:1:2:1768446000000", score: 1, terms: [] })).toBe(1768446000000);
    expect(viewTime({ view: "feeds", title: "", feeds: [] })).toBeNull();

    const now = Date.parse("2026-09-30T21:00:00Z");
    const time = { at: "2026-09-30T21:00:00.000Z", from: "2026-08-31T21:00:00.000Z", to: "2026-09-30T21:00:00.000Z" };
    // Inside the 24 h trail: leave TIME alone.
    expect(timeForInstant(time, now - VISIBLE_TRAIL_MS + 60_000, now)).toBeNull();
    // Older: the cursor jumps to the first 15-minute step at or after the record, inside the window.
    expect(timeForInstant(time, Date.parse("2026-09-02T18:09:00Z"), now)).toEqual({ ...time, at: "2026-09-02T18:15:00.000Z" });
    // Before the window: the window slides to hold it, and never past now.
    const moved = timeForInstant(time, Date.parse("2026-01-15T02:00:00Z"), now)!;
    expect(moved.at).toBe("2026-01-15T02:00:00.000Z");
    expect(Date.parse(moved.from)).toBeLessThanOrEqual(Date.parse(moved.at));
    expect(Date.parse(moved.to)).toBeGreaterThanOrEqual(Date.parse(moved.at));
    expect(Date.parse(moved.to) - Date.parse(moved.from)).toBe(30 * 24 * H);
    // A future instant (a forecast) clamps to now.
    expect(timeForInstant(time, now + 5 * H, now)).toBeNull();
  });

  test("panel camera: Cesium's 60° spans the wider side, so a landscape screen fits by height", () => {
    // A square box, ~75 km a side at 25.5°N.
    const box = { west: -80.81, south: 25.13, east: -80.08, north: 25.81 };
    const heightM = 0.68 * 111_320;
    const landscape = altitudeForBox(box, { width: 1440, height: 900 }, 1);
    const vHalf = Math.atan(Math.tan(Math.PI / 6) / 1.6);
    expect(landscape).toBe(Math.round(heightM / 2 / Math.tan(vHalf)));
    // Portrait: the 60° is vertical, and the narrower horizontal angle decides.
    const widthM = 0.73 * 111_320 * Math.cos(25.47 * (Math.PI / 180));
    const portrait = altitudeForBox(box, { width: 900, height: 1440 }, 1);
    expect(portrait).toBe(Math.round(widthM / 2 / Math.tan(vHalf)));
    expect(altitudeForBox(box, { width: 1440, height: 900 })).toBeGreaterThan(landscape);
  });
});
