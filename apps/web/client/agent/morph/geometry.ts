/**
 * Rect helpers for the orb → card morph. `measureElementRect` / `rectToCss` are deedee's
 * `rect-geometry.ts`; `cardTargetRect` places the card for this app.
 */

export type ElementRect = { top: number; left: number; width: number; height: number };
export type Viewport = { width: number; height: number };

/** Card size on wide screens (PRD §12: "about 360×480"). */
export const CARD_WIDTH = 360;
export const CARD_HEIGHT = 480;
/** Minimum gap between the card and the viewport edge. */
export const CARD_MARGIN = 12;
/** Below this viewport width the card becomes a full-width bottom sheet. */
export const SHEET_BREAKPOINT = 480;
/** Space a sheet leaves above itself so the HUD top bar stays visible. */
export const SHEET_TOP_GAP = 56;

export function measureElementRect(el: Element): ElementRect {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function rectToCss(rect: ElementRect): ElementRect {
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

export function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Place a span of `size` inside [0, extent], CARD_MARGIN from both ends when there is room for it. */
function placeWithin(start: number, size: number, extent: number): number {
  const lo = Math.min(CARD_MARGIN, Math.max(0, extent - size));
  const hi = Math.max(lo, extent - CARD_MARGIN - size);
  return Math.min(Math.max(start, lo), hi);
}

/**
 * Where the card goes. Wide screens: CARD_WIDTH × CARD_HEIGHT, grown up and left from the orb's bottom-right
 * corner, shrunk and shifted so it stays CARD_MARGIN inside the viewport. Under SHEET_BREAKPOINT: a
 * full-width sheet on the bottom edge. Either way the result lies inside the viewport.
 */
export function cardTargetRect(source: ElementRect | null, viewport: Viewport): ElementRect {
  const vw = Math.max(0, viewport.width);
  const vh = Math.max(0, viewport.height);

  if (vw < SHEET_BREAKPOINT) {
    const height = Math.min(CARD_HEIGHT, Math.max(0, vh - SHEET_TOP_GAP));
    return { top: vh - height, left: 0, width: vw, height };
  }

  const width = Math.min(CARD_WIDTH, Math.max(0, vw - 2 * CARD_MARGIN));
  const height = Math.min(CARD_HEIGHT, Math.max(0, vh - 2 * CARD_MARGIN));
  const right = source ? source.left + source.width : vw - CARD_MARGIN;
  const bottom = source ? source.top + source.height : vh - CARD_MARGIN;
  return {
    top: placeWithin(bottom - height, height, vh),
    left: placeWithin(right - width, width, vw),
    width,
    height,
  };
}
