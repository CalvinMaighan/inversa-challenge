import { describe, expect, test } from "bun:test";

import { alertBands, alertSampleTimes, alertsQuery, alertsVariables, collectAlerts, severityToken, type AlertRow } from "client/hud/timeline/alerts";
import { bucketCounts, sparkY } from "client/hud/timeline/sparkline";
import { formatClocks, isLive } from "client/hud/topbar/clock";

describe("sparkline bucketing", () => {
  test("fewer buckets than frames: contiguous, exhaustive, and sums preserved", () => {
    const counts = Uint32Array.from({ length: 10 }, (_, i) => i + 1); // 1..10, total 55
    const b = bucketCounts(counts, 3);
    // floor(k·10/3): [0,3) [3,6) [6,10)
    expect(Array.from(b.values)).toEqual([1 + 2 + 3, 4 + 5 + 6, 7 + 8 + 9 + 10]);
    expect(b.total).toBe(55);
    expect(b.values.reduce((a, v) => a + v, 0)).toBe(55);
    expect(b.max).toBe(34);
  });

  test("uneven division never drops or double-counts a frame", () => {
    for (const n of [1, 7, 96, 97, 2881]) {
      const counts = Uint32Array.from({ length: n }, (_, i) => (i * 7919) % 13);
      const total = counts.reduce((a, v) => a + v, 0);
      for (const buckets of [1, 2, 5, 64, Math.min(n, 400)]) {
        if (buckets > n) continue;
        const b = bucketCounts(counts, buckets);
        expect(b.values.length).toBe(buckets);
        expect(b.values.reduce((a, v) => a + v, 0)).toBe(total);
      }
    }
  });

  test("more buckets than frames: each bucket shows the frame under it", () => {
    const b = bucketCounts([2, 0, 5], 6);
    expect(Array.from(b.values)).toEqual([2, 2, 0, 0, 5, 5]);
    expect(b.max).toBe(5);
    expect(b.total).toBe(7);
  });

  test("empty inputs", () => {
    expect(bucketCounts([], 10)).toEqual({ values: new Float64Array(10), max: 0, total: 0 });
    expect(bucketCounts([1, 2], 0).values.length).toBe(0);
  });

  test("square-root y scale: zero at the baseline, max at the top, flat when empty", () => {
    expect(sparkY(0, 16, 24)).toBe(24);
    expect(sparkY(16, 16, 24)).toBe(0);
    expect(sparkY(4, 16, 24)).toBe(12);
    expect(sparkY(3, 0, 24)).toBe(24);
  });
});

describe("alert bands", () => {
  const from = Date.parse("2026-09-01T00:00:00Z");
  const to = Date.parse("2026-09-02T00:00:00Z");
  const row = (id: string, onset: string | null, expires: string | null, severity = "Severe"): AlertRow => ({ id, event: "Freeze Warning", severity, headline: null, onset, expires });

  test("samples cover the window at a fixed spacing and include both ends", () => {
    const s = alertSampleTimes(from, to, 3 * 3600_000);
    expect(s.length).toBe(9);
    expect(s[0]).toBe(from);
    expect(s[8]).toBe(to);
    expect(alertSampleTimes(to, from)).toEqual([]);
  });

  test("one aliased document for all samples, deduplicated on the way back", () => {
    const q = alertsQuery(2);
    expect(q).toContain("$bbox: BBox!, $t0: Time!, $t1: Time!");
    expect(q).toContain("a0: alerts(bbox: $bbox, at: $t0)");
    expect(q).toContain("a1: alerts(bbox: $bbox, at: $t1)");
    const vars = alertsVariables({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 }, [from, to]);
    expect(vars).toEqual({ bbox: { west: -83.2, south: 24.3, east: -79.8, north: 27.5 }, t0: "2026-09-01T00:00:00.000Z", t1: "2026-09-02T00:00:00.000Z" });
    const a = row("a", null, null);
    const b = row("b", null, null);
    expect(collectAlerts({ a0: [a, b], a1: [b], a2: null }).map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("bands clip to the window, open ends run to the window edge, and overlaps stack into lanes", () => {
    const bands = alertBands(
      [
        row("late", "2026-09-01T20:00:00Z", null),
        row("early", "2026-08-31T20:00:00Z", "2026-09-01T06:00:00Z"),
        row("overlap", "2026-09-01T03:00:00Z", "2026-09-01T09:00:00Z", "Moderate"),
        row("gone", "2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z"),
        row("after", "2026-09-01T07:00:00Z", "2026-09-01T08:00:00Z"),
      ],
      from,
      to,
    );
    expect(bands.map((b) => [b.id, b.lane, new Date(b.startMs).toISOString().slice(11, 16), new Date(b.endMs).toISOString().slice(11, 16)])).toEqual([
      ["early", 0, "00:00", "06:00"],
      ["overlap", 1, "03:00", "09:00"],
      ["after", 0, "07:00", "08:00"],
      ["late", 0, "20:00", "00:00"],
    ]);
  });

  test("severity tokens", () => {
    expect(severityToken("Extreme")).toBe("danger");
    expect(severityToken("Severe")).toBe("danger");
    expect(severityToken("Moderate")).toBe("warn");
    expect(severityToken("Minor")).toBe("muted");
  });
});

describe("clocks", () => {
  test("UTC and South Florida local time, with the zone abbreviation", () => {
    const c = formatClocks(Date.parse("2026-09-30T20:30:05Z"));
    expect(c).toEqual({ utc: "20:30:05Z", local: "16:30:05", zone: "EDT", date: "30 SEP" });
    expect(formatClocks(Date.parse("2026-01-15T12:00:00Z")).zone).toBe("EST");
  });

  test("live when the cursor sits on the window end", () => {
    expect(isLive({ at: "2026-09-30T20:30:00Z", to: "2026-09-30T20:30:00Z" })).toBe(true);
    expect(isLive({ at: "2026-09-30T20:15:00Z", to: "2026-09-30T20:30:00Z" })).toBe(false);
    expect(isLive({ at: null, to: "2026-09-30T20:30:00Z" })).toBe(true);
  });

  test("the end of a historical window is not live", () => {
    const now = Date.parse("2026-09-30T20:40:00Z");
    expect(isLive({ at: "2026-09-30T20:30:00Z", to: "2026-09-30T20:30:00Z" }, now)).toBe(true);
    expect(isLive({ at: "2026-02-16T17:00:00Z", to: "2026-02-16T17:00:00Z" }, now)).toBe(false);
    expect(isLive({ at: null, to: "2026-02-16T17:00:00Z" }, now)).toBe(false);
  });
});
