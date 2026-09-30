import { describe, expect, test } from "bun:test";

import { assumedFrame0, frameIndexAt, frameStartMs } from "client/globe/frame-index";

const STEP = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

describe("frameIndexAt", () => {
  test("maps (at - frame0) / step onto whole frames", () => {
    expect(frameIndexAt(T0, T0, STEP, 96)).toBe(0);
    expect(frameIndexAt(T0 + STEP, T0, STEP, 96)).toBe(1);
    expect(frameIndexAt(T0 + 10 * STEP, T0, STEP, 96)).toBe(10);
  });

  test("an instant inside a frame belongs to that frame (floor, not round)", () => {
    expect(frameIndexAt(T0 + STEP - 1, T0, STEP, 96)).toBe(0);
    expect(frameIndexAt(T0 + 2.5 * STEP, T0, STEP, 96)).toBe(2);
  });

  test("clamps to the resident grid", () => {
    expect(frameIndexAt(T0 - 7 * STEP, T0, STEP, 96)).toBe(0);
    expect(frameIndexAt(T0 + 500 * STEP, T0, STEP, 96)).toBe(95);
  });

  test("-1 when there is nothing to show", () => {
    expect(frameIndexAt(T0, T0, STEP, 0)).toBe(-1);
    expect(frameIndexAt(T0, T0, 0, 96)).toBe(-1);
    expect(frameIndexAt(Number.NaN, T0, STEP, 96)).toBe(-1);
  });

  test("hourly frames (EVF2 default step) work the same", () => {
    const hour = 60 * 60_000;
    expect(frameIndexAt(T0 + 5 * hour + 59 * 60_000, T0, hour, 744)).toBe(5);
  });

  test("frameStartMs inverts frameIndexAt on step boundaries", () => {
    for (const i of [0, 1, 47, 95]) expect(frameIndexAt(frameStartMs(i, T0, STEP), T0, STEP, 96)).toBe(i);
  });

  test("assumedFrame0 puts the last frame on the live edge", () => {
    const to = T0 + 95 * STEP;
    expect(assumedFrame0(to, STEP, 96)).toBe(T0);
    expect(frameIndexAt(to, assumedFrame0(to, STEP, 96), STEP, 96)).toBe(95);
    expect(assumedFrame0(to, STEP, 0)).toBe(to);
  });
});
