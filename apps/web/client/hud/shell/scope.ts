/**
 * The map window (the scope, docs/GODS_EYE.md GC2, GE9, GE11): the part of the globe that is always fully visible on
 * the stage layout, with the page black around it. Three independent controls make it:
 *
 * - shape: `circle` (the stage diameter, as tall as the cards allow), `oval` (an ellipse as tall as the circle and
 *   `WIDE_ASPECT` times as wide, never wider than the page inside its gutters), `rounded` (a rounded rectangle in
 *   the same box as the oval) or `frame` (the whole page inside its gutters);
 * - size: 30..100 percent of that box, scaled about the stage centre (so the area goes with the square of it);
 * - feather (the soft edge): how the map fades out OUTSIDE the shape. The shape itself is never dimmed. At 0 the
 *   edge is hard and everything beyond it is black; as it grows the map fades out gradually beyond the edge, over a
 *   longer distance and down to a brighter floor; at 100 there is no vignette at all.
 *
 * Pure: the stage shell turns a `ScopeWindow` into the CSS mask over the globe canvas (an SVG: a floor, the shape
 * grown by half the fade and blurred, then the sharp shape on top, so every shape fades alike), the pointer clip and
 * the `[data-stage]` box; camera framings read the opaque part (`client/globe/fit.ts`). The page has its mask before
 * hydration: `SCOPE_MASK_CSS` (geometry.ts) draws the default circle in CSS alone.
 */
import { DEFAULT_SCOPE_FEATHER, DEFAULT_SCOPE_SHAPE, DEFAULT_SCOPE_SIZE, featherOf, shapeOf, sizeOf, type ScopeShape } from "client/state/look";

import { GUTTER_PX, stageDiameter } from "./geometry";

/** Oval and rounded: this many times as wide as the circle is tall. */
export const WIDE_ASPECT = 1.5;
/** Rounded: the corner radius as a share of the window's shorter side. */
export const ROUNDED_CORNER_SHARE = 0.12;
/**
 * The blur's standard deviation as a share of the fade distance: the Gaussian edge runs from 99% to 1% opaque over
 * 2 × 2.33 σ, so σ = fade / 4.66 spends the whole fade, and the blurred shape, grown by half the fade, falls from
 * 99% at the window's edge to 1% at the end of the fade.
 */
const SIGMA_PER_FADE = 1 / 4.66;

export type ScopeWindow = {
  shape: ScopeShape;
  /** Centre, page px (the stage centre: the centre of the viewport). */
  cx: number;
  cy: number;
  /** The window's box, px: fully visible inside, never changed by the soft edge. */
  width: number;
  height: number;
  /** Corner radius, px: half the shorter side for the circle; the oval is an ellipse whatever this says. */
  corner: number;
  /** Fade distance, px, outward from the box's edge. 0 is a hard edge. */
  feather: number;
  /** How visible the map still is far outside the window, 0..1 (1: no vignette). */
  floor: number;
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

/** The fade distance as a share of half the window's shorter side, and the floor, for a feather of 0..100. */
export function fadeOf(feather: number): { share: number; floor: number } {
  const t = Math.min(1, Math.max(0, feather / 100));
  return { share: t, floor: t * t };
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
  const fade = fadeOf(featherOf(keys.feather ?? DEFAULT_SCOPE_FEATHER));
  return { shape, cx: w / 2, cy: h / 2, width, height, corner, feather: fade.share * (short / 2), floor: fade.floor };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The always fully visible part of the window, what a camera framing may use: an ellipse (`rx`, `ry`) for the circle
 * and the oval, a rectangle (`width`, `height`, `corner`) for the others. The soft edge lies outside it.
 */
export function opaqueWindow(win: ScopeWindow): { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } | { kind: "rect"; cx: number; cy: number; width: number; height: number; corner: number } {
  if (win.shape === "circle" || win.shape === "oval") {
    return { kind: "ellipse", cx: win.cx, cy: win.cy, rx: win.width / 2, ry: win.height / 2 };
  }
  return { kind: "rect", cx: win.cx, cy: win.cy, width: win.width, height: win.height, corner: win.corner };
}

/** The shape as an SVG element, its box grown by `grow` px on every side (a negative `grow` is not used). */
function shapeElement(win: ScopeWindow, grow: number, attrs: string): string {
  const hw = win.width / 2 + grow;
  const hh = win.height / 2 + grow;
  if (win.shape === "circle" || win.shape === "oval") {
    return `<ellipse cx="${r1(win.cx)}" cy="${r1(win.cy)}" rx="${r1(hw)}" ry="${r1(hh)}"${attrs}/>`;
  }
  return `<rect x="${r1(win.cx - hw)}" y="${r1(win.cy - hh)}" width="${r1(2 * hw)}" height="${r1(2 * hh)}" rx="${r1(win.corner + grow)}"${attrs}/>`;
}

/**
 * The mask as an SVG the size of the page, black where the map shows (alpha is the visibility):
 * 1. a floor over the whole page at `win.floor` (nothing at feather 0; the whole page opaque at feather 100);
 * 2. the shape grown by half the fade and blurred, so visibility falls from about 1 at the window's edge to the
 *    floor at the end of the fade, outward;
 * 3. the sharp shape on top, so the inside is exactly 1 whatever the soft edge.
 */
export function scopeMaskSvg(win: ScopeWindow, vw: number, vh: number): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${r1(vw)}" height="${r1(vh)}" viewBox="0 0 ${r1(vw)} ${r1(vh)}">`;
  if (win.floor >= 1) return `${open}<rect width="${r1(vw)}" height="${r1(vh)}"/></svg>`;
  const parts: string[] = [];
  let defs = "";
  if (win.floor > 0.001) parts.push(`<rect width="${r1(vw)}" height="${r1(vh)}" fill-opacity="${Math.round(win.floor * 1000) / 1000}"/>`);
  const sigma = win.feather * SIGMA_PER_FADE;
  if (sigma >= 0.05) {
    defs = `<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${r1(vw)}" height="${r1(vh)}"><feGaussianBlur stdDeviation="${r1(sigma)}"/></filter></defs>`;
    parts.push(shapeElement(win, win.feather / 2, ` filter="url(#f)"`));
  }
  parts.push(shapeElement(win, 0, ""));
  return `${open}${defs}${parts.join("")}</svg>`;
}

/** `scopeMaskSvg` as a CSS `mask-image` value. */
export function scopeMaskCss(win: ScopeWindow, vw: number, vh: number): string {
  return `url("data:image/svg+xml,${encodeURIComponent(scopeMaskSvg(win, vw, vh))}")`;
}

/**
 * The pointer clip on a page-sized element. With a soft edge the map shows (and takes clicks) outside the shape, so
 * there is no clip; with a hard edge the black margin takes no clicks meant for hidden markers.
 */
export function scopeClipCss(win: ScopeWindow): string {
  if (win.feather > 0 || win.floor > 0) return "none";
  const hw = win.width / 2;
  const hh = win.height / 2;
  if (win.shape === "circle" || win.shape === "oval") return `ellipse(${r1(hw)}px ${r1(hh)}px at ${r1(win.cx)}px ${r1(win.cy)}px)`;
  return `inset(${r1(win.cy - hh)}px ${r1(win.cx - hw)}px ${r1(win.cy - hh)}px ${r1(win.cx - hw)}px round ${r1(win.corner)}px)`;
}
