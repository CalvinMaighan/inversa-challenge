/**
 * Where the zoom column goes (gates/leaf-GE8.md G2): the rightmost free slot of its band, left of the sighting
 * card and of any other card on that side (`data-hud-obstacle`), measured as they open, close and resize. Where no
 * slot fits the full column, the `+`/`-` pair alone (`data-compact`); on a phone it is always the pair.
 */
import { MOBILE_QUERY } from "../primitives";

/** Room kept at the right edge for the sighting card's collapsed tab, px. */
export const TAB_ROOM_PX = 36;
export const FULL_WIDTH_PX = 132;
/** The +/- pair alone: width and height (two 32 px buttons, the gap and the padding), px. */
const COMPACT_WIDTH_PX = 48;
const COMPACT_HEIGHT_PX = 84;
/** Space kept between the column and a card beside it, and from the pane's left edge, px. */
const SLOT_GAP_PX = 12;

export type Interval = readonly [number, number];

/**
 * The rightmost slot `width` wide inside [lo, hi] that misses every blocked interval (with `gap` to spare), as its
 * right edge; null when none fits.
 */
export function rightmostSlot(lo: number, hi: number, width: number, blocked: readonly Interval[], gap = SLOT_GAP_PX): number | null {
  let right = hi;
  // Each pass moves the slot left of the leftmost card it still hits; at most one pass per card.
  for (let pass = 0; pass <= blocked.length; pass += 1) {
    const hits = blocked.filter(([l, r]) => l < right + gap && r > right - width - gap);
    if (hits.length === 0) return right - width >= lo ? right : null;
    right = Math.min(...hits.map(([l]) => l)) - gap;
  }
  return null;
}

/** Measure and place `col` (absolutely positioned in its offset parent); `fullHeight` is the full column's height. */
export function placeColumn(col: HTMLElement, fullHeight: number): void {
  const pane = col.offsetParent as HTMLElement | null;
  if (!pane) return;
  const c = pane.getBoundingClientRect();
  const box = col.getBoundingClientRect();
  // The column is centred on its top (translateY(-50%)), so its centre does not move with its height.
  const cy = (box.top + box.bottom) / 2;
  const root = col.closest("[data-hud]") ?? document;
  const cards = [...root.querySelectorAll<HTMLElement>("[data-hud-obstacle]")]
    .filter((el) => !col.contains(el) && !el.contains(col))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  const fit = (width: number, height: number) => {
    const top = cy - height / 2;
    const bottom = cy + height / 2;
    const blocked = cards.filter((r) => r.top < bottom && r.bottom > top).map((r): Interval => [r.left, r.right]);
    return rightmostSlot(c.left + SLOT_GAP_PX, c.right - TAB_ROOM_PX, width, blocked);
  };
  const phone = window.matchMedia(MOBILE_QUERY).matches;
  const full = phone ? null : fit(FULL_WIDTH_PX, fullHeight);
  const right = full ?? fit(phone ? box.width : COMPACT_WIDTH_PX, phone ? box.height : COMPACT_HEIGHT_PX);
  if (full === null && !phone) col.dataset.compact = "";
  else delete col.dataset.compact;
  if (right !== null) col.style.setProperty("--zoom-right", `${Math.round(c.right - right)}px`);
  else col.style.removeProperty("--zoom-right");
}
