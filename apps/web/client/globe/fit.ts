/**
 * Framing a box (or aiming at a point) in the part of the globe the user can really see: the pane minus the HUD
 * obstacles along its edges (`freeRect`) and, on the stage layout (docs/GODS_EYE.md GC1), only inside the opaque
 * part of the scope circle `[data-stage]` (`visibleRect`), never in the black margin or under a card. The fixed-margin
 * framings (`frameSites`, `frameAreas`) are the fallbacks before the pane is laid out.
 */
import { get } from "@calvinjs/active-state";

import type { BBox } from "shared/agent/events";
import { VIEW, type ViewState } from "client/state/view";

import { getGlobe } from "./api";
import type { CameraPose } from "./camera";

/** Pixels, relative to the pane's top-left corner. */
export type Rect = { left: number; top: number; right: number; bottom: number };
/** The visible disc of the stage, pane pixels: centre and the radius of its opaque part. */
export type Circle = { cx: number; cy: number; r: number };

const METRES_PER_DEG = 111_320;
/** Cesium's default field of view (60°) spans the larger of the canvas's two sides. */
const HALF_FOV = Math.PI / 6;
/** Steps per side of the search for the best rect inside the circle. */
const SEARCH_STEPS = 40;
/** Room kept around a point the camera aims at (a marker and its label). */
const POINT_INSET_PX = 32;

/** Metres per pixel of a straight-down camera at `altitudeM` over a pane of `paneW` × `paneH` px. */
const metresPerPx = (altitudeM: number, paneW: number, paneH: number) => (altitudeM * 2 * Math.tan(HALF_FOV)) / Math.max(paneW, paneH);

/** The camera over `centre` shifted so that `centre` lands on `free`'s centre instead of the pane's. */
function shifted(centre: { lat: number; lon: number }, mpp: number, paneW: number, paneH: number, free: Rect) {
  const cos = Math.cos((centre.lat * Math.PI) / 180);
  const dx = (free.left + free.right) / 2 - paneW / 2;
  const dy = (free.top + free.bottom) / 2 - paneH / 2;
  return { lat: centre.lat + (dy * mpp) / METRES_PER_DEG, lon: centre.lon - (dx * mpp) / (METRES_PER_DEG * cos) };
}

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
  return { ...shifted({ lat: midLat, lon: midLon }, mpp, paneW, paneH, free), altitudeM, heading: 0, pitch: -90 };
}

/** The straight-down camera at `altitudeM` that puts `point` on the centre of `free`. */
export function aimPoint(point: { lat: number; lon: number }, altitudeM: number, paneW: number, paneH: number, free: Rect): CameraPose {
  return { ...shifted(point, metresPerPx(altitudeM, paneW, paneH), paneW, paneH, free), altitudeM, heading: 0, pitch: -90 };
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
 * The rect a framing may use: inside `free` and, when the stage shows a circle, inside its opaque disc. Of the
 * rects that fit both, the one that shows a box of `aspect` (width / height) largest: a search over the rect's top
 * and bottom edges, each giving the widest chord the circle allows between them. Without a circle, `free` itself.
 */
export function visibleRect(free: Rect, circle: Circle | null, aspect = 1): Rect {
  if (!circle) return free;
  const top0 = Math.max(free.top, circle.cy - circle.r);
  const bottom0 = Math.min(free.bottom, circle.cy + circle.r);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let best: Rect | null = null;
  let bestScore = -1;
  let bestArea = -1;
  const step = (bottom0 - top0) / SEARCH_STEPS;
  if (!(step > 0)) return { left: circle.cx, top: circle.cy, right: circle.cx, bottom: circle.cy };
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const top = top0 + i * step;
    for (let j = i + 1; j <= SEARCH_STEPS; j++) {
      const bottom = top0 + j * step;
      const far = Math.max(Math.abs(top - circle.cy), Math.abs(bottom - circle.cy));
      const half = Math.sqrt(Math.max(0, circle.r * circle.r - far * far));
      const left = Math.max(free.left, circle.cx - half);
      const right = Math.min(free.right, circle.cx + half);
      if (right <= left) continue;
      // The scale a box of this aspect gets: limited by the width or by the height. Ties go to the larger rect,
      // which keeps a narrow strip (a card over half the circle) centred on the circle rather than at its top.
      const score = Math.min((right - left) / a, bottom - top);
      const area = (right - left) * (bottom - top);
      if (score > bestScore + 0.5 || (score > bestScore - 0.5 && area > bestArea)) {
        bestScore = Math.max(bestScore, score);
        bestArea = area;
        best = { left, top, right, bottom };
      }
    }
  }
  return best ?? { left: circle.cx, top: circle.cy, right: circle.cx, bottom: circle.cy };
}

/** The live pane: its size, the free rect and the stage's opaque disc (null off the stage layout or scope off). */
export function paneFrame(): { width: number; height: number; free: Rect; circle: Circle | null } | null {
  if (typeof document === "undefined") return null;
  const pane = document.querySelector<HTMLElement>('[data-slot="globe-pane"]');
  if (!pane) return null;
  const p = pane.getBoundingClientRect();
  if (p.width < 50 || p.height < 50) return null;
  // The top bar is no obstacle to clicks (its middle lets them through), but its buttons sit over the map.
  const obstacles = [...pane.querySelectorAll<HTMLElement>('[data-hud-obstacle], [data-testid="hud-topbar"]')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const free = freeRect(p, obstacles);
  return { width: p.width, height: p.height, free, circle: stageCircle(p) };
}

/** `[data-stage]`'s disc in pane pixels, shrunk to its opaque part (the feather fades the rest to black). */
function stageCircle(pane: DOMRect): Circle | null {
  const shell = document.querySelector<HTMLElement>("[data-shell]");
  const stage = document.querySelector<HTMLElement>("[data-stage]");
  if (!shell || !stage || shell.dataset.scope === "off") return null;
  const s = stage.getBoundingClientRect();
  if (s.width < 50 || s.height < 50) return null;
  const feather = Number.parseFloat(getComputedStyle(shell).getPropertyValue("--scope-feather"));
  const opaque = 1 - (Number.isFinite(feather) ? Math.min(1, Math.max(0, feather)) : 0);
  return { cx: s.left + s.width / 2 - pane.left, cy: s.top + s.height / 2 - pane.top, r: (s.width / 2) * opaque };
}

const inset = (r: Rect, px: number): Rect => {
  const x = Math.min(px, (r.right - r.left) / 2 - 1);
  const y = Math.min(px, (r.bottom - r.top) / 2 - 1);
  return { left: r.left + Math.max(0, x), top: r.top + Math.max(0, y), right: r.right - Math.max(0, x), bottom: r.bottom - Math.max(0, y) };
};

/**
 * `fitBBox` against the live DOM: the visible rect (free of the HUD, inside the stage circle) for the box's shape,
 * inset by `insetPx` (room for a marker and its label at the box's edge). Null before the pane is laid out.
 */
export function fitInPane(bbox: BBox, insetPx = 0, margin = 1.05): CameraPose | null {
  const frame = paneFrame();
  if (!frame) return null;
  const cos = Math.cos((((bbox.south + bbox.north) / 2) * Math.PI) / 180);
  const aspect = ((bbox.east - bbox.west) * cos) / Math.max(1e-9, bbox.north - bbox.south);
  const rect = visibleRect(frame.free, frame.circle, aspect);
  return fitBBox(bbox, frame.width, frame.height, inset(rect, insetPx), margin);
}

/** A screen point lies inside a rect. */
export const inRect = (p: { x: number; y: number }, r: Rect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/**
 * Keep a place in sight after the HUD changed around it (a sighting card opened over the marker that was clicked):
 * when its screen point has left the visible rect, or sits in its outer `POINT_INSET_PX`, the camera glides,
 * straight down at the same height, until the place sits at the rect's centre. Returns whether it moved.
 */
export function keepInView(at: { lat: number; lon: number }): boolean {
  const globe = getGlobe();
  const frame = paneFrame();
  if (!globe || !frame) return false;
  const rect = visibleRect(frame.free, frame.circle);
  const p = globe.project(at.lon, at.lat);
  if (p && inRect(p, inset(rect, POINT_INSET_PX))) return false;
  const altitudeM = get<ViewState>(VIEW)?.altitudeM ?? VIEW.defaults.altitudeM;
  globe.flyTo({ ...aimPoint(at, altitudeM, frame.width, frame.height, rect), durationS: 0.8 });
  return true;
}

/** The box around points. */
export function boxOf(points: readonly { lat: number; lon: number }[]): BBox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
}
