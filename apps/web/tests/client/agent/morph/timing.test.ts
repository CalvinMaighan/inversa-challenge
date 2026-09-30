import { afterEach, describe, expect, test } from "bun:test";

import { MORPH_FADE_MS, MORPH_MS, beat, morphTiming, prefersReducedMotion } from "client/agent/morph/timing";

const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
const originalWindow = g.window;

/** A window whose matchMedia answers `prefers-reduced-motion: reduce` with `reduce`. */
function fakeWindow(reduce: boolean): void {
  g.window = { matchMedia: (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" }) };
}

afterEach(() => {
  if (hadWindow) g.window = originalWindow;
  else delete g.window;
});

describe("morph timing", () => {
  test("durations are 0 under reduced motion", () => {
    fakeWindow(true);
    expect(prefersReducedMotion()).toBe(true);
    const timing = morphTiming(prefersReducedMotion());
    expect(timing).toEqual({ fadeMs: 0, morphMs: 0 });
    expect(beat(timing.morphMs)).toBe("0ms cubic-bezier(0.4, 0, 0.2, 1)");
  });

  test("full beats otherwise (deedee 150 ms fade, 200 ms morph)", () => {
    fakeWindow(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(morphTiming(prefersReducedMotion())).toEqual({ fadeMs: MORPH_FADE_MS, morphMs: MORPH_MS });
    expect([MORPH_FADE_MS, MORPH_MS]).toEqual([150, 200]);
  });

  test("no window (server render) counts as full motion", () => {
    delete g.window;
    expect(prefersReducedMotion()).toBe(false);
  });
});
