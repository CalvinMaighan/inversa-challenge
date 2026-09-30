import { describe, expect, test } from "bun:test";

import { clampToWindow, DEFAULT_SPEED, retime, TIME, TIME_STEP_MINUTES, TIME_WINDOW_DAYS, timeWindow, windowFor } from "client/state/time";

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

  test("windowFor: the live window for recent or future times, a centred 30 days for older ones", () => {
    const now = Date.parse("2026-09-30T20:44:00Z");
    const live = timeWindow(now);
    expect(windowFor(Date.parse("2026-09-15T10:07:00Z"), now)).toEqual({ ...live, at: "2026-09-15T10:00:00.000Z" });
    expect(windowFor(Date.parse("2027-01-01T00:00:00Z"), now)).toEqual(live);
    expect(windowFor(Date.parse(live.from), now)).toEqual({ ...live, at: live.from });
    const cold = windowFor(Date.parse("2026-02-01T17:00:00Z"), now);
    expect(cold).toEqual({ at: "2026-02-01T17:00:00.000Z", from: "2026-01-17T17:00:00.000Z", to: "2026-02-16T17:00:00.000Z" });
    expect(Date.parse(cold.to) - Date.parse(cold.from)).toBe(TIME_WINDOW_DAYS * 86_400_000);
  });

  test("retime keeps the window when the time is inside it and moves it otherwise", () => {
    const now = Date.parse("2026-09-30T20:44:00Z");
    const narrow = { from: "2026-01-30T00:00:00.000Z", to: "2026-02-04T00:00:00.000Z" };
    expect(retime(narrow, Date.parse("2026-02-01T17:05:00Z"), now)).toEqual({ ...narrow, at: "2026-02-01T17:00:00.000Z" });
    expect(retime(narrow, Date.parse("2026-09-01T00:00:00Z"), now)).toEqual({ ...timeWindow(now), at: "2026-09-01T00:00:00.000Z" });
    expect(retime({ from: "bad", to: "bad" }, Date.parse("2026-09-01T00:00:00Z"), now).from).toBe(timeWindow(now).from);
  });
});
