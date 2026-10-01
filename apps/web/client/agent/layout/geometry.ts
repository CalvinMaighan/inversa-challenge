/**
 * Chat column geometry (PRD §12 "Layout", T40): the column's width on desktop and the bottom sheet's snap
 * heights on phones, plus the animation lengths reduced motion zeroes. Pure, so the tests pin every edge.
 */
import type { SheetSnap } from "client/state/agent";

/** Column width, CSS px: the default, and the range the resize handle and keyboard keep it in. */
export const COLUMN_DEFAULT_PX = 420;
export const COLUMN_MIN_PX = 360;
export const COLUMN_MAX_PX = 560;
/** Keyboard resize step (arrow keys on the handle). */
export const COLUMN_STEP_PX = 16;
/** The globe pane never gets narrower than this; a narrow window takes width from the column first. */
export const GLOBE_MIN_PX = 360;
/** localStorage key for the width the reader dragged to. */
export const COLUMN_WIDTH_STORAGE_KEY = "inversa:chat-column-width";

/** Below this viewport width the column becomes a bottom sheet over a full-screen globe. */
export const SHEET_BREAKPOINT_PX = 768;
export const SHEET_QUERY = `(max-width: ${SHEET_BREAKPOINT_PX - 0.02}px)`;
export const SHEET_MEDIA = `@media ${SHEET_QUERY}`;
/** Collapsed sheet: grab handle plus the composer bar. The globe pane stops above it. */
export const SHEET_PEEK_PX = 72;
/** Share of the viewport the half snap covers. */
export const SHEET_HALF_FRACTION = 0.5;
/** Gap left above the full sheet so the handle stays clear of the status bar. */
export const SHEET_FULL_TOP_PX = 8;
/** Release speed (px per ms) that counts as a fling to the next snap, whatever the distance. */
export const SHEET_FLING_PX_PER_MS = 0.5;

/** Animation lengths; `motionMs` zeroes them under prefers-reduced-motion. */
export const SHEET_MS = 240;
export const POPOUT_MS = 180;

/**
 * Column width within [COLUMN_MIN_PX, COLUMN_MAX_PX], narrowed so the globe keeps GLOBE_MIN_PX when the
 * viewport is known. A non-finite width falls back to the default.
 */
export function clampColumnWidth(px: number, viewportWidth?: number): number {
  const want = Number.isFinite(px) ? px : COLUMN_DEFAULT_PX;
  const room = viewportWidth !== undefined && Number.isFinite(viewportWidth) ? viewportWidth - GLOBE_MIN_PX : Infinity;
  const max = Math.max(COLUMN_MIN_PX, Math.min(COLUMN_MAX_PX, room));
  return Math.round(Math.min(max, Math.max(COLUMN_MIN_PX, want)));
}

/** Width stored by an earlier visit; anything unparsable or out of range is ignored or clamped. */
export function parseStoredWidth(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return COLUMN_DEFAULT_PX;
  const n = Number(raw);
  return Number.isFinite(n) ? clampColumnWidth(n) : COLUMN_DEFAULT_PX;
}

/** Keyboard resize on the separator (ARIA window splitter): arrows step, Home/End jump; null for other keys. */
export function widthForKey(current: number, key: string, viewportWidth?: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampColumnWidth(current - COLUMN_STEP_PX, viewportWidth);
    case "ArrowRight":
      return clampColumnWidth(current + COLUMN_STEP_PX, viewportWidth);
    case "Home":
      return clampColumnWidth(COLUMN_MIN_PX, viewportWidth);
    case "End":
      return clampColumnWidth(COLUMN_MAX_PX, viewportWidth);
    default:
      return null;
  }
}

/** Sheet height in px for a snap point in a viewport `viewportHeight` tall. */
export function sheetHeight(snap: SheetSnap, viewportHeight: number): number {
  const vh = Math.max(0, viewportHeight);
  switch (snap) {
    case "collapsed":
      return Math.min(SHEET_PEEK_PX, vh);
    case "half":
      return Math.max(Math.min(SHEET_PEEK_PX, vh), Math.round(vh * SHEET_HALF_FRACTION));
    case "full":
      return Math.max(0, vh - SHEET_FULL_TOP_PX);
  }
}

const SNAP_ORDER: readonly SheetSnap[] = ["collapsed", "half", "full"];

/**
 * Where a released drag settles: a fling (|velocity| ≥ SHEET_FLING_PX_PER_MS, positive = growing) moves one
 * snap past the nearest one below/above the release height; otherwise the nearest snap wins.
 */
export function snapSheet(heightPx: number, velocityPxPerMs: number, viewportHeight: number): SheetSnap {
  const heights = SNAP_ORDER.map((s) => sheetHeight(s, viewportHeight));
  const h = Number.isFinite(heightPx) ? heightPx : heights[0]!;
  if (Math.abs(velocityPxPerMs) >= SHEET_FLING_PX_PER_MS) {
    if (velocityPxPerMs > 0) return SNAP_ORDER[heights.findIndex((x) => x > h + 1)] ?? "full";
    const below = heights.map((x, i) => [x, i] as const).filter(([x]) => x < h - 1);
    return below.length ? SNAP_ORDER[below[below.length - 1]![1]]! : "collapsed";
  }
  let best = 0;
  for (let i = 1; i < heights.length; i += 1) if (Math.abs(heights[i]! - h) < Math.abs(heights[best]! - h)) best = i;
  return SNAP_ORDER[best]!;
}

/** The next snap up (tap on the handle cycles collapsed → half → full → collapsed). */
export function nextSnap(snap: SheetSnap): SheetSnap {
  return SNAP_ORDER[(SNAP_ORDER.indexOf(snap) + 1) % SNAP_ORDER.length]!;
}

/** Animation length for this reader: 0 under prefers-reduced-motion. */
export function motionMs(baseMs: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : baseMs;
}

export const MOTION_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/** CSS `transition` for `property`, or `none` when the length is 0 (reduced motion, or mid-drag). */
export function transitionFor(property: string, ms: number): string {
  return ms > 0 ? `${property} ${ms}ms ${MOTION_EASE}` : "none";
}

/** True when the browser asks for reduced motion; false outside a browser. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
