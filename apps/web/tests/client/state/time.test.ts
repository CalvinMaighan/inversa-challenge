import { describe, expect, test } from "bun:test";

import { clampToWindow, DEFAULT_SPEED, TIME, TIME_STEP_MINUTES, TIME_WINDOW_DAYS, timeWindow } from "client/state/time";

const STEP = TIME_STEP_MINUTES * 60_000;

describe("TIME", () => {
  test("defaults: paused at 8 fps on the live edge of a 30-day window", () => {
    const t = TIME.defaults;
    expect(t.playing).toBe(false);
    expect(t.speed).toBe(8);
    expect(DEFAULT_SPEED).toBe(8);
    expect(t.at).toBe(t.to);
    expect(Date.parse(t.to) - Date.parse(t.from)).toBe(TIME_WINDOW_DAYS * 86_400_000);
    expect(Date.parse(t.at) % STEP).toBe(0);
    expect(TIME.at).toBe("TIME.at");
  });

  test("timeWindow floors now to the 15-minute frame step", () => {
    const now = Date.parse("2026-09-30T20:44:59.999Z");
    expect(timeWindow(now)).toEqual({
      at: "2026-09-30T20:30:00.000Z",
      from: "2026-08-31T20:30:00.000Z",
      to: "2026-09-30T20:30:00.000Z",
    });
    expect(timeWindow(Date.parse("2026-09-30T20:45:00.000Z")).to).toBe("2026-09-30T20:45:00.000Z");
  });

  test("clampToWindow snaps to the nearest step and stays inside the window", () => {
    const w = timeWindow(Date.parse("2026-09-30T20:30:00Z"));
    expect(clampToWindow(Date.parse("2026-09-15T10:07:00Z"), w)).toBe("2026-09-15T10:00:00.000Z");
    expect(clampToWindow(Date.parse("2026-09-15T10:08:00Z"), w)).toBe("2026-09-15T10:15:00.000Z");
    expect(clampToWindow(Date.parse("2027-01-01T00:00:00Z"), w)).toBe(w.to);
    expect(clampToWindow(Date.parse("2020-01-01T00:00:00Z"), w)).toBe(w.from);
  });
});
