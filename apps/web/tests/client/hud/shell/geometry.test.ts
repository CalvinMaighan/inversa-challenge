import { describe, expect, test } from "bun:test";

import { COLUMN_MIN_PX, SHEET_BREAKPOINT_PX } from "client/agent/layout/geometry";
import {
  CARD_MAX_WIDTH_CSS,
  cardMaxWidth,
  CENTRE_CLEAR_PX,
  DEFAULT_FEATHER,
  featherValue,
  GUTTER_PX,
  SCOPE_MASK_CSS,
  SIDE_ROOM_PX,
  STAGE_DIAMETER_CSS,
  STAGE_MIN_PX,
  STAGE_QUERY,
  stageDiameter,
} from "client/hud/shell/geometry";

describe("stage geometry", () => {
  test("the stage layout starts where the phone sheet stops", () => {
    expect(STAGE_MIN_PX).toBe(SHEET_BREAKPOINT_PX);
    expect(STAGE_QUERY).toBe("(min-width: 768px)");
    expect(SIDE_ROOM_PX).toBe(COLUMN_MIN_PX + 2 * GUTTER_PX);
  });

  test("1440×900: the stage fits between two narrowest cards", () => {
    expect(stageDiameter(1440, 900)).toBe(1440 - 2 * SIDE_ROOM_PX);
    expect(stageDiameter(1440, 900)).toBe(672);
  });

  test("1920×1080: as tall as the screen less the gutters", () => {
    expect(stageDiameter(1920, 1080)).toBe(1080 - 2 * GUTTER_PX);
  });

  test("1024×768: never below 72% of the height; the cards overlap its edges instead", () => {
    expect(stageDiameter(1024, 768)).toBeCloseTo(0.72 * 768, 6);
  });

  test("portrait tablet: bounded by the width", () => {
    expect(stageDiameter(800, 1200)).toBe(800 - 2 * GUTTER_PX);
  });

  test("degenerate viewports give 0, never a negative size", () => {
    expect(stageDiameter(0, 0)).toBe(0);
    expect(stageDiameter(-5, 10)).toBe(0);
    expect(stageDiameter(20, 20)).toBe(0);
  });

  test("cards stop CENTRE_CLEAR_PX short of the centre", () => {
    for (const vw of [768, 1024, 1440, 1920]) {
      const right = GUTTER_PX + cardMaxWidth(vw);
      expect(vw / 2 - right).toBe(CENTRE_CLEAR_PX);
    }
    expect(cardMaxWidth(10)).toBe(0);
    expect(CARD_MAX_WIDTH_CSS).toBe("calc(50vw - 60px)");
  });

  test("the CSS mirrors the function", () => {
    expect(STAGE_DIAMETER_CSS).toBe("min(100dvh - 24px, 100vw - 24px, max(100vw - 768px, 72dvh))");
    // First paint: fully visible to the radius, then a fade OUTSIDE it, over the feather share of the radius.
    expect(SCOPE_MASK_CSS).toContain(`var(--scope-feather, ${DEFAULT_FEATHER})`);
    expect(SCOPE_MASK_CSS.startsWith("radial-gradient(circle at 50% 50%, #000 calc(")).toBe(true);
    expect(SCOPE_MASK_CSS).toContain("(1 + var(--scope-feather");
    expect(DEFAULT_FEATHER).toBe(0.4);
  });

  test("feather values are clamped to 0..1", () => {
    expect(featherValue(0.11)).toBe("0.11");
    expect(featherValue(2)).toBe("1");
    expect(featherValue(-1)).toBe("0");
    expect(featherValue(Number.NaN)).toBe(String(DEFAULT_FEATHER));
  });
});
