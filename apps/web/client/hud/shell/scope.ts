/**
 * The map window (the scope, docs/GODS_EYE.md GC2, GE9): where the globe shows through the black page on the stage
 * layout. Three independent controls make it:
 *
 * - shape: `circle` (the stage diameter, as tall as the cards allow), `oval` (an ellipse as tall as the circle and
 *   `WIDE_ASPECT` times as wide, never wider than the page inside its gutters), `rounded` (a rounded rectangle in
 *   the same box as the oval) or `frame` (the whole page inside its gutters, with only the soft edge);
 * - size: 30..100 percent of that box, scaled about the stage centre (so the area goes with the square of it);
 * - feather: the soft edge, 0..100 percent of half the window's shorter side; it fades the window to black inward
 *   from the box's edge and never moves the box.
 *
 * Pure: the stage shell turns a `ScopeWindow` into the CSS mask over the globe canvas (an SVG shape blurred by a
 * Gaussian, so every shape feathers alike), the pointer clip and the `[data-stage]` box; camera framings read the
 * opaque part (`client/globe/fit.ts`). The page has its mask before hydration: `SCOPE_MASK_CSS` (geometry.ts) draws
 * the default circle in CSS alone.
 */
import { DEFAULT_SCOPE_FEATHER, DEFAULT_SCOPE_SHAPE, DEFAULT_SCOPE_SIZE, featherOf, shapeOf, sizeOf, type ScopeShape } from "client/state/look";

import { GUTTER_PX, stageDiameter } from "./geometry";

/** Oval and rounded: this many times as wide as the circle is tall. */
export const WIDE_ASPECT = 1.5;
/** Rounded: the corner radius as a share of the window's shorter side. */
export const ROUNDED_CORNER_SHARE = 0.12;
/**
 * The blur's standard deviation as a share of the feather width: the Gaussian edge runs from 99% to 1% opaque over
 * 2 × 2.33 σ, so σ = feather / 4.66 spends the whole feather and the blurred shape, inset by half the feather, ends
 * at the box's edge.
 */
const SIGMA_PER_FEATHER = 1 / 4.66;

export type ScopeWindow = {
  shape: ScopeShape;
  /** Centre, page px (the stage centre: the centre of the viewport). */
  cx: number;
  cy: number;
  /** The window's box, px. */
  width: number;
  height: number;
  /** Corner radius, px: half the shorter side for the circle; the oval is an ellipse whatever this says. */
  corner: number;
  /** Soft edge width, px, inward from the box's edge. */
  feather: number;
};

export type ScopeKeys = { shape?: unknown; size?: unknown; feather?: unknown };

/** The box a shape may fill at size 100, before scaling. */
function fullBox(shape: ScopeShape, vw: number, vh: number): { width: number; height: number } {
  const d = stageDiameter(vw, vh);
  const pageW = Math.max(0, vw - 2 * GUTTER_PX);
  const pageH = Math.max(0, vh - 2 * GUTTER_PX);
  switch (shape) {
    case "circle":
      return { width: d, height: d };
    case "oval":
    case "rounded":
      return { width: Math.min(pageW, d * WIDE_ASPECT), height: d };
    case "frame":
      return { width: pageW, height: pageH };
  }
}

/** The window for a viewport and the three keys (validated here: anything unusable is its default). */
export function scopeWindow(vw: number, vh: number, keys: ScopeKeys = {}): ScopeWindow {
  const w = Number.isFinite(vw) ? Math.max(0, vw) : 0;
  const h = Number.isFinite(vh) ? Math.max(0, vh) : 0;
  const shape = shapeOf(keys.shape ?? DEFAULT_SCOPE_SHAPE);
  const scale = sizeOf(keys.size ?? DEFAULT_SCOPE_SIZE) / 100;
  const box = fullBox(shape, w, h);
  const width = box.width * scale;
  const height = box.height * scale;
  const short = Math.min(width, height);
  const corner = shape === "circle" || shape === "oval" ? short / 2 : shape === "rounded" ? short * ROUNDED_CORNER_SHARE : 0;
  const feather = (featherOf(keys.feather ?? DEFAULT_SCOPE_FEATHER) / 100) * (short / 2);
  return { shape, cx: w / 2, cy: h / 2, width, height, corner, feather };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The opaque part of the window (mask at least 99%), what a camera framing may use: an ellipse (`rx`, `ry`) for the
 * circle and the oval, a rectangle (`width`, `height`, `corner`) for the others.
 */
export function opaqueWindow(win: ScopeWindow): { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } | { kind: "rect"; cx: number; cy: number; width: number; height: number; corner: number } {
  const f = win.feather;
  if (win.shape === "circle" || win.shape === "oval") {
    return { kind: "ellipse", cx: win.cx, cy: win.cy, rx: Math.max(0, win.width / 2 - f), ry: Math.max(0, win.height / 2 - f) };
  }
  return { kind: "rect", cx: win.cx, cy: win.cy, width: Math.max(0, win.width - 2 * f), height: Math.max(0, win.height - 2 * f), corner: Math.max(0, win.corner - f) };
}

/**
 * The mask as an SVG the size of the page: the shape, inset by half the feather, filled black (opaque) and blurred
 * so its edge fades over the feather width. Feather 0: no filter, a hard edge on the box.
 */
export function scopeMaskSvg(win: ScopeWindow, vw: number, vh: number): string {
  const f = win.feather;
  const sigma = f * SIGMA_PER_FEATHER;
  const filter = sigma >= 0.05 ? `<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${r1(vw)}" height="${r1(vh)}"><feGaussianBlur stdDeviation="${r1(sigma)}"/></filter>` : "";
  const use = filter ? ` filter="url(#f)"` : "";
  const hw = Math.max(0, win.width / 2 - f / 2);
  const hh = Math.max(0, win.height / 2 - f / 2);
  const shape =
    win.shape === "circle" || win.shape === "oval"
      ? `<ellipse cx="${r1(win.cx)}" cy="${r1(win.cy)}" rx="${r1(hw)}" ry="${r1(hh)}"${use}/>`
      : `<rect x="${r1(win.cx - hw)}" y="${r1(win.cy - hh)}" width="${r1(2 * hw)}" height="${r1(2 * hh)}" rx="${r1(Math.max(0, win.corner - f / 2))}"${use}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r1(vw)}" height="${r1(vh)}" viewBox="0 0 ${r1(vw)} ${r1(vh)}">${filter ? `<defs>${filter}</defs>` : ""}${shape}</svg>`;
}

/** `scopeMaskSvg` as a CSS `mask-image` value. */
export function scopeMaskCss(win: ScopeWindow, vw: number, vh: number): string {
  return `url("data:image/svg+xml,${encodeURIComponent(scopeMaskSvg(win, vw, vh))}")`;
}

/** The pointer clip on a page-sized element: the window's box, so the black margin takes no clicks. */
export function scopeClipCss(win: ScopeWindow): string {
  const hw = win.width / 2;
  const hh = win.height / 2;
  if (win.shape === "circle" || win.shape === "oval") return `ellipse(${r1(hw)}px ${r1(hh)}px at ${r1(win.cx)}px ${r1(win.cy)}px)`;
  return `inset(${r1(win.cy - hh)}px ${r1(win.cx - hw)}px ${r1(win.cy - hh)}px ${r1(win.cx - hw)}px round ${r1(win.corner)}px)`;
}
