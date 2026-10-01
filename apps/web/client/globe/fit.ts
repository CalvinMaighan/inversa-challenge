/**
 * Framing a box in the part of the globe pane the HUD leaves free. The fixed-margin framings (`frameSites`,
 * `frameAreas`) assume a landscape pane with a panel on the left and a timeline at the bottom; on a phone the
 * pane is portrait and the bars take a different share of it, so the box is fitted to the measured free rect.
 */
import type { BBox } from "shared/agent/events";

import type { CameraPose } from "./camera";

/** Pixels, relative to the pane's top-left corner. */
export type Rect = { left: number; top: number; right: number; bottom: number };

const METRES_PER_DEG = 111_320;
/** Cesium's default field of view (60°) spans the larger of the canvas's two sides. */
const HALF_FOV = Math.PI / 6;

/**
 * The straight-down camera that shows `bbox` inside `free` (with `margin` to spare) on a pane of `paneW` × `paneH`
 * px: the altitude from the metres per pixel the free rect allows, and the centre shifted so the box's centre lands
 * on the free rect's centre.
 */
export function fitBBox(bbox: BBox, paneW: number, paneH: number, free: Rect, margin = 1.15): CameraPose {
  const midLat = (bbox.south + bbox.north) / 2;
  const midLon = (bbox.west + bbox.east) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  const widthM = (bbox.east - bbox.west) * METRES_PER_DEG * cos;
  const heightM = (bbox.north - bbox.south) * METRES_PER_DEG;
  const fw = Math.max(40, free.right - free.left);
  const fh = Math.max(40, free.bottom - free.top);
  const mpp = Math.max(widthM / fw, heightM / fh) * margin;
  const altitudeM = Math.round((mpp * Math.max(paneW, paneH)) / (2 * Math.tan(HALF_FOV)));
  const dx = (free.left + free.right) / 2 - paneW / 2;
  const dy = (free.top + free.bottom) / 2 - paneH / 2;
  return {
    lat: midLat + (dy * mpp) / METRES_PER_DEG,
    lon: midLon - (dx * mpp) / (METRES_PER_DEG * cos),
    altitudeM,
    heading: 0,
    pitch: -90,
  };
}

/**
 * The pane's free rect: the pane minus the HUD obstacles (`[data-hud-obstacle]`) along its edges. A wide obstacle
 * is a bar (top or bottom half), a tall one a side panel (left or right half), a small one takes its nearest edge.
 */
export function freeRect(pane: Rect, obstacles: readonly Rect[]): Rect {
  const w = pane.right - pane.left;
  const h = pane.bottom - pane.top;
  const free: Rect = { left: 0, top: 0, right: w, bottom: h };
  const rects = obstacles
    .map((o) => ({ left: Math.max(0, o.left - pane.left), top: Math.max(0, o.top - pane.top), right: Math.min(w, o.right - pane.left), bottom: Math.min(h, o.bottom - pane.top) }))
    .filter((r) => r.right > r.left && r.bottom > r.top);
  const small: Rect[] = [];
  for (const r of rects) {
    if (r.right - r.left >= w * 0.5) {
      if ((r.top + r.bottom) / 2 < h / 2) free.top = Math.max(free.top, r.bottom);
      else free.bottom = Math.min(free.bottom, r.top);
    } else if (r.bottom - r.top >= h * 0.5) {
      if ((r.left + r.right) / 2 < w / 2) free.left = Math.max(free.left, r.right);
      else free.right = Math.min(free.right, r.left);
    } else small.push(r);
  }
  // A small control (a corner button, a tab) still inside the free rect: cut the side that keeps the most area.
  for (const r of small) {
    if (r.right <= free.left || r.left >= free.right || r.bottom <= free.top || r.top >= free.bottom) continue;
    const fw = free.right - free.left;
    const fh = free.bottom - free.top;
    const cuts: [keyof Rect, number, number][] = [
      ["top", r.bottom, fw * (free.bottom - r.bottom)],
      ["bottom", r.top, fw * (r.top - free.top)],
      ["left", r.right, fh * (free.right - r.right)],
      ["right", r.left, fh * (r.left - free.left)],
    ];
    const [side, at] = cuts.reduce((best, c) => (c[2] > best[2] ? c : best));
    free[side] = at;
  }
  return free;
}

/**
 * `fitBBox` against the live DOM: the globe pane and the HUD obstacles in it, the free rect inset by `insetPx` (room
 * for a marker and its label at the box's edge). Null before the pane is laid out.
 */
export function fitInPane(bbox: BBox, insetPx = 0, margin = 1.05): CameraPose | null {
  const pane = document.querySelector<HTMLElement>('[data-slot="globe-pane"]');
  if (!pane) return null;
  const p = pane.getBoundingClientRect();
  if (p.width < 50 || p.height < 50) return null;
  // The top bar is no obstacle to clicks (its middle lets them through), but its buttons sit over the map.
  const obstacles = [...pane.querySelectorAll<HTMLElement>('[data-hud-obstacle], [data-testid="hud-topbar"]')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const f = freeRect(p, obstacles);
  return fitBBox(bbox, p.width, p.height, { left: f.left + insetPx, top: f.top + insetPx, right: f.right - insetPx, bottom: f.bottom - insetPx }, margin);
}

/** The box around points. */
export function boxOf(points: readonly { lat: number; lon: number }[]): BBox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}
