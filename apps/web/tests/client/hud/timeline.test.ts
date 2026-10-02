import { describe, expect, test } from "bun:test";
import { init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { APP } from "client/state/app";


import { bucketCounts, sparkY } from "client/hud/timeline/sparkline";
import { formatClocks, isLive } from "client/hud/topbar/clock";

init(state);

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

describe("clocks", () => {
  test("UTC and South Florida local time, with the zone abbreviation", () => {
    const c = formatClocks(Date.parse("2026-09-30T20:30:05Z"), "America/New_York");
    expect(c).toEqual({ utc: "20:30:05Z", local: "16:30:05", zone: "EDT", date: "30 SEP" });
    expect(formatClocks(Date.parse("2026-01-15T12:00:00Z"), "America/New_York").zone).toBe("EST");
  });

  test("active app: local time is the app's zone (carp: Louisiana, python: South Florida)", () => {
    const at = Date.parse("2026-09-30T20:30:05Z");
    set(APP, { id: "carp" });
    expect(formatClocks(at)).toMatchObject({ local: "15:30:05", zone: "CDT" });
    set(APP, { id: "python" });
    expect(formatClocks(at)).toMatchObject({ local: "16:30:05", zone: "EDT" });
    set(APP, APP.defaults);
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
