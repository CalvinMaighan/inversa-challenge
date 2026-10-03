import { describe, expect, test } from "bun:test";

import { DAY_PLAY_MIN_WINDOW_DAYS, playStride, STEP_MS } from "client/hud/timeline/frames";

const DAY = 86_400_000;

describe("play stride", () => {
  test("a 2-year window plays a day a frame (96 steps of 15 minutes), so 8x is 8 days a second", () => {
    expect(playStride(0, 730 * DAY)).toBe(96);
    expect(96 * STEP_MS).toBe(DAY);
    expect((730 * DAY) / (8 * DAY)).toBeCloseTo(91.25, 2);
  });

  test("90 days, 180 days and a year play by the day too; 30 days keeps the fine step", () => {
    for (const days of [90, 180, 365]) expect(playStride(0, days * DAY)).toBe(96);
    expect(playStride(0, 30 * DAY)).toBe(1);
    expect(playStride(0, DAY_PLAY_MIN_WINDOW_DAYS * DAY)).toBe(1);
    expect(playStride(0, (DAY_PLAY_MIN_WINDOW_DAYS + 1) * DAY)).toBe(96);
  });
});
