import { describe, expect, test } from "bun:test";

import { frameForTime, frameStartMs, stepMsOf } from "client/globe/frame-index";

import { fakeMeta } from "./fakes";

const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const meta = fakeMeta(T0, 720); // one hourly grid over 30 days

describe("TIME → frame index (C16)", () => {
  test("floors (at - frame0) / step", () => {
    expect(frameForTime(T0, meta)).toBe(0);
    expect(frameForTime(T0 + HOUR - 1, meta)).toBe(0);
    expect(frameForTime(T0 + HOUR, meta)).toBe(1);
    // TIME moves in 15-minute steps; four of them land in the same hourly frame.
    expect([0, 15, 30, 45].map((m) => frameForTime(T0 + 5 * HOUR + m * 60_000, meta))).toEqual([5, 5, 5, 5]);
    expect(frameForTime(T0 + 719 * HOUR + 59 * 60_000, meta)).toBe(719);
  });

  test("-1 outside the grid, never clamped onto an edge frame", () => {
    expect(frameForTime(T0 - 1, meta)).toBe(-1);
    expect(frameForTime(T0 + 720 * HOUR, meta)).toBe(-1);
    expect(frameForTime(T0, null)).toBe(-1);
    expect(frameForTime(Number.NaN, meta)).toBe(-1);
    expect(frameForTime(T0, fakeMeta(T0, 0))).toBe(-1);
  });

  test("15-minute grids work the same", () => {
    const quarter = fakeMeta(T0, 96, 15);
    expect(stepMsOf(quarter)).toBe(15 * 60_000);
    expect(frameForTime(T0 + 2.5 * 15 * 60_000, quarter)).toBe(2);
  });

  test("frameStartMs inverts the mapping on frame boundaries", () => {
    for (const i of [0, 1, 47, 719]) expect(frameForTime(frameStartMs(i, T0, HOUR), meta)).toBe(i);
  });
});
