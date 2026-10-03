/**
 * Stage layout geometry (docs/GODS_EYE.md GC1): a black page, the globe in a centred circular stage, the chat
 * card on the left and the sighting card on the right. Pure, so tests pin the numbers the CSS uses.
 *
 * From STAGE_MIN_PX up the cards float over the page; they never reach the stage centre. Below it, phones keep
 * the docked sheets (chat sheet at the bottom, evidence as a bottom sheet).
 */
import { SHEET_BREAKPOINT_PX } from "client/agent/layout/geometry";
import { GAP_M_PX } from "client/themes/palette";

/** Stage layout from this viewport width up; the phone docks below it. Same edge as the chat sheet. */
export const STAGE_MIN_PX = SHEET_BREAKPOINT_PX;
export const STAGE_QUERY = `(min-width: ${STAGE_MIN_PX}px)`;
export const STAGE_MEDIA = `@media ${STAGE_QUERY}`;

/**
 * Space between the viewport edge, the cards, the bars and the stage (GE9): the `--gap-m` token, one unit everywhere.
 * CSS on the stage chrome writes `var(--gap-m)`; maths uses this number.
 */
export const GUTTER_PX = GAP_M_PX;
/** Room a side keeps for a card at its narrowest (360 px) plus a gutter each side of it. */
export const SIDE_ROOM_PX = 360 + 2 * GUTTER_PX;
/** Short screens: the stage keeps at least this share of the viewport height, cards then overlap its edges. */
export const STAGE_MIN_HEIGHT_SHARE = 0.72;
/** A card's right (chat) or left (details) edge stays this far from the stage centre. */
export const CENTRE_CLEAR_PX = 48;
/** Soft edge default (GC2 SCOPE_FEATHER 40 of 100): the fade outside the window, as a share of its radius. */
export const DEFAULT_FEATHER = 0.35;

/**
 * Stage diameter in px for a viewport: as tall as the screen allows, narrowed so both cards fit beside it on a
 * wide screen, but never below 72% of the height (there the cards overlap the stage edges instead).
 */
export function stageDiameter(viewportWidth: number, viewportHeight: number): number {
  const vw = Math.max(0, viewportWidth);
  const vh = Math.max(0, viewportHeight);
  const fit = Math.max(vw - 2 * SIDE_ROOM_PX, STAGE_MIN_HEIGHT_SHARE * vh);
  return Math.max(0, Math.min(vh - 2 * GUTTER_PX, vw - 2 * GUTTER_PX, fit));
}

/** `stageDiameter` as CSS, against the viewport (the stage pane fills it). */
export const STAGE_DIAMETER_CSS = `min(100dvh - ${2 * GUTTER_PX}px, 100vw - ${2 * GUTTER_PX}px, max(100vw - ${2 * SIDE_ROOM_PX}px, ${STAGE_MIN_HEIGHT_SHARE * 100}dvh))`;

/** Widest a floating card may be: its inner edge stays CENTRE_CLEAR_PX from the viewport centre. */
export function cardMaxWidth(viewportWidth: number): number {
  return Math.max(0, viewportWidth / 2 - GUTTER_PX - CENTRE_CLEAR_PX);
}

export const CARD_MAX_WIDTH_CSS = `calc(50vw - ${GUTTER_PX + CENTRE_CLEAR_PX}px)`;

/** Feather as the CSS variable value (0..1); anything unusable falls back to the default. */
export function featherValue(feather: number): string {
  const f = Number.isFinite(feather) ? Math.min(1, Math.max(0, feather)) : DEFAULT_FEATHER;
  return String(Math.round(f * 1000) / 1000);
}

/**
 * The default window (circle, size 100) as CSS alone, for the first paint before the shell measures the page and
 * sets `--scope-mask` (client/hud/shell/scope.ts): fully visible inside the radius, then fading out beyond it over
 * the feather share of the radius, down to a floor of the share squared (the same profile as the measured mask,
 * with a straight fade), read from `--scope-feather` on the shell.
 */
const STAGE_RADIUS_CSS = `calc(${STAGE_DIAMETER_CSS} / 2)`;
const FEATHER_VAR = `var(--scope-feather, ${DEFAULT_FEATHER})`;
export const SCOPE_MASK_CSS = `radial-gradient(circle at 50% 50%, #000 ${STAGE_RADIUS_CSS}, rgb(0 0 0 / calc(${FEATHER_VAR} * ${FEATHER_VAR})) calc(${STAGE_RADIUS_CSS} * (1 + ${FEATHER_VAR})))`;

/**
 * The progressive blur's mask before the shell measures the page: the inverse of `SCOPE_MASK_CSS`, clear inside the
 * radius and rising to `1 - feather²` at the end of the fade.
 */
export const SCOPE_BLUR_MASK_CSS = `radial-gradient(circle at 50% 50%, transparent ${STAGE_RADIUS_CSS}, rgb(0 0 0 / calc(1 - ${FEATHER_VAR} * ${FEATHER_VAR})) calc(${STAGE_RADIUS_CSS} * (1 + ${FEATHER_VAR})))`;
