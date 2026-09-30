import { describe, expect, test } from "bun:test";

import {
  CARD_HEIGHT,
  CARD_MARGIN,
  CARD_WIDTH,
  SHEET_BREAKPOINT,
  SHEET_TOP_GAP,
  cardTargetRect,
  rectToCss,
  type ElementRect,
  type Viewport,
} from "client/agent/morph/geometry";

/** The orb as AppShell places it: 48 px, 20 px in from the bottom-right corner. */
const orbIn = (vp: Viewport): ElementRect => ({ top: vp.height - 68, left: vp.width - 68, width: 48, height: 48 });

const inside = (r: ElementRect, vp: Viewport) => r.left >= 0 && r.top >= 0 && r.left + r.width <= vp.width && r.top + r.height <= vp.height;

describe("card geometry", () => {
  test("desktop: 360×480 grown up and left from the orb's bottom-right corner", () => {
    const vp = { width: 1280, height: 800 };
    const orb = orbIn(vp);
    expect(cardTargetRect(orb, vp)).toEqual({ top: 780 - CARD_HEIGHT, left: 1260 - CARD_WIDTH, width: CARD_WIDTH, height: CARD_HEIGHT });
  });

  test("clamps inside the margin when the source sits near the top-left", () => {
    const vp = { width: 1024, height: 768 };
    expect(cardTargetRect({ top: 4, left: 4, width: 48, height: 48 }, vp)).toEqual({
      top: CARD_MARGIN,
      left: CARD_MARGIN,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
  });

  test("clamps a source past the right and bottom edges back inside", () => {
    const vp = { width: 900, height: 700 };
    const rect = cardTargetRect({ top: 900, left: 1200, width: 48, height: 48 }, vp);
    expect(rect.left + rect.width).toBe(vp.width - CARD_MARGIN);
    expect(rect.top + rect.height).toBe(vp.height - CARD_MARGIN);
  });

  test("shrinks to a short viewport instead of overflowing it", () => {
    const vp = { width: 1280, height: 400 };
    const rect = cardTargetRect(orbIn(vp), vp);
    expect(rect.height).toBe(400 - 2 * CARD_MARGIN);
    expect(rect.top).toBe(CARD_MARGIN);
    expect(inside(rect, vp)).toBe(true);
  });

  test(`under ${SHEET_BREAKPOINT} px wide: a full-width sheet on the bottom edge`, () => {
    const vp = { width: 375, height: 812 };
    expect(cardTargetRect(orbIn(vp), vp)).toEqual({ top: 812 - CARD_HEIGHT, left: 0, width: 375, height: CARD_HEIGHT });
    const landscape = { width: 470, height: 320 };
    expect(cardTargetRect(orbIn(landscape), landscape)).toEqual({ top: SHEET_TOP_GAP, left: 0, width: 470, height: 320 - SHEET_TOP_GAP });
  });

  test("always inside the viewport, across sizes and with no source", () => {
    for (const width of [0, 200, 320, 375, 479, 480, 481, 600, 768, 1024, 1440, 2560]) {
      for (const height of [0, 40, 300, 480, 504, 600, 812, 1200]) {
        const vp = { width, height };
        for (const source of [orbIn(vp), null]) {
          const rect = cardTargetRect(source, vp);
          expect(rect.width).toBeGreaterThanOrEqual(0);
          expect(rect.height).toBeGreaterThanOrEqual(0);
          expect(inside(rect, vp)).toBe(true);
        }
      }
    }
  });

  test("rectToCss rounds to whole pixels and never goes negative", () => {
    expect(rectToCss({ top: 10.4, left: 20.6, width: 359.5, height: -3 })).toEqual({ top: 10, left: 21, width: 360, height: 0 });
  });
});
