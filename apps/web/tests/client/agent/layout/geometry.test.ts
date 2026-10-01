import { afterEach, describe, expect, test } from "bun:test";

import {
  clampColumnWidth,
  COLUMN_DEFAULT_PX,
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  GLOBE_MIN_PX,
  motionMs,
  nextSnap,
  parseStoredWidth,
  POPOUT_MS,
  prefersReducedMotion,
  SHEET_BREAKPOINT_PX,
  SHEET_MS,
  SHEET_PEEK_PX,
  SHEET_QUERY,
  sheetHeight,
  snapSheet,
  transitionFor,
  widthForKey,
} from "client/agent/layout/geometry";

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

describe("layout: column width", () => {
  test("defaults to 420 and stays within 360-560", () => {
    expect([COLUMN_DEFAULT_PX, COLUMN_MIN_PX, COLUMN_MAX_PX]).toEqual([420, 360, 560]);
    expect(clampColumnWidth(100)).toBe(360);
    expect(clampColumnWidth(9999)).toBe(560);
    expect(clampColumnWidth(447.6)).toBe(448);
    expect(clampColumnWidth(Number.NaN)).toBe(420);
  });

  test("a narrow window takes width from the column first, never below the minimum", () => {
    // 1024 px: the globe keeps 360, so the column tops out at 664 → still 560.
    expect(clampColumnWidth(560, 1024)).toBe(560);
    // 900 px: the column can only be 540 if the globe keeps its 360.
    expect(clampColumnWidth(560, 900)).toBe(900 - GLOBE_MIN_PX);
    // 600 px: below both minimums, the column keeps 360 (the sheet layout takes over there anyway).
    expect(clampColumnWidth(500, 600)).toBe(360);
  });

  test("stored width: parsed, clamped, junk ignored", () => {
    expect(parseStoredWidth(null)).toBe(420);
    expect(parseStoredWidth("")).toBe(420);
    expect(parseStoredWidth("abc")).toBe(420);
    expect(parseStoredWidth("500")).toBe(500);
    expect(parseStoredWidth("2000")).toBe(560);
    expect(parseStoredWidth("12")).toBe(360);
  });

  test("keyboard resize: arrows step 16 px, Home/End jump, other keys ignored", () => {
    expect(widthForKey(420, "ArrowRight")).toBe(436);
    expect(widthForKey(420, "ArrowLeft")).toBe(404);
    expect(widthForKey(368, "ArrowLeft")).toBe(360);
    expect(widthForKey(420, "Home")).toBe(360);
    expect(widthForKey(420, "End")).toBe(560);
    expect(widthForKey(420, "End", 880)).toBe(520);
    expect(widthForKey(420, "Enter")).toBeNull();
  });
});

describe("layout: phone sheet", () => {
  test("the sheet layout starts under 768 px", () => {
    expect(SHEET_BREAKPOINT_PX).toBe(768);
    expect(SHEET_QUERY).toBe("(max-width: 767.98px)");
  });

  test("snap heights: composer bar, half the screen, full height", () => {
    expect(sheetHeight("collapsed", 812)).toBe(SHEET_PEEK_PX);
    expect(sheetHeight("half", 812)).toBe(406);
    expect(sheetHeight("full", 812)).toBe(804);
    // A tiny viewport never yields a half sheet smaller than the bar.
    expect(sheetHeight("half", 100)).toBe(SHEET_PEEK_PX);
    expect(sheetHeight("collapsed", 40)).toBe(40);
  });

  test("a slow release settles on the nearest snap", () => {
    expect(snapSheet(90, 0, 812)).toBe("collapsed");
    expect(snapSheet(300, 0, 812)).toBe("half");
    expect(snapSheet(500, 0, 812)).toBe("half");
    expect(snapSheet(700, 0, 812)).toBe("full");
    expect(snapSheet(Number.NaN, 0, 812)).toBe("collapsed");
  });

  test("a fling moves past the nearest snap in its direction", () => {
    // Just above collapsed, flung up: half. Just below full, flung down: half.
    expect(snapSheet(100, 1.2, 812)).toBe("half");
    expect(snapSheet(780, -1.2, 812)).toBe("half");
    // Above half, flung up: full. Below half, flung down: collapsed.
    expect(snapSheet(420, 0.8, 812)).toBe("full");
    expect(snapSheet(390, -0.8, 812)).toBe("collapsed");
    // Flinging past the ends stays at the ends.
    expect(snapSheet(804, 2, 812)).toBe("full");
    expect(snapSheet(72, -2, 812)).toBe("collapsed");
  });

  test("a tap on the handle cycles collapsed → half → full → collapsed", () => {
    expect(nextSnap("collapsed")).toBe("half");
    expect(nextSnap("half")).toBe("full");
    expect(nextSnap("full")).toBe("collapsed");
  });
});

describe("layout: motion", () => {
  test("reduced motion: the sheet and the pop-out animate in 0 ms", () => {
    fakeWindow(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(motionMs(SHEET_MS, prefersReducedMotion())).toBe(0);
    expect(motionMs(POPOUT_MS, prefersReducedMotion())).toBe(0);
    expect(transitionFor("height", motionMs(SHEET_MS, prefersReducedMotion()))).toBe("none");
  });

  test("full motion otherwise: 240 ms sheet, 180 ms pop-out", () => {
    fakeWindow(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(motionMs(SHEET_MS, prefersReducedMotion())).toBe(240);
    expect(motionMs(POPOUT_MS, prefersReducedMotion())).toBe(180);
    expect(transitionFor("height", 240)).toBe("height 240ms cubic-bezier(0.4, 0, 0.2, 1)");
  });

  test("no window (server render) counts as full motion", () => {
    delete g.window;
    expect(prefersReducedMotion()).toBe(false);
  });
});
