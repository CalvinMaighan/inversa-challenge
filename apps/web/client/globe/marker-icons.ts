/**
 * Marker images for the sightings layer: the app's icon (`shared/app-icons.ts`, a python is a snake) drawn once per
 * colour on a small canvas, tinted in the label colour over a dark outline so it reads on satellite imagery in
 * every theme. Cesium keeps one texture-atlas region per image id (`Billboard.setImage(id, canvas)`), so a
 * thousand pythons share one snake; nothing is drawn per marker.
 */
import { appIconShape, ICON_STROKE, ICON_VIEWBOX } from "shared/app-icons";

import { createCanvas } from "./layers/raster-surface";

/** Marker canvas edge, px: the 24 px icon plus its outline, and the hit target (at least 24 px). */
export const MARKER_PX = 32;
/** Ring canvas edge, px: drawn around a selected marker (white) or a conflicting one (red). */
export const RING_PX = 44;
const OUTLINE = "#0b0d12";
const OUTLINE_WIDTH = 5.5;

export type MarkerImage = { id: string; image: HTMLCanvasElement };

const cache = new Map<string, MarkerImage>();

/** Stroke every path, circle and dot of an icon onto `g`, scaled from the 24 box into `px`, with `inset` padding. */
function strokeIcon(g: CanvasRenderingContext2D, icon: string, px: number, inset: number, color: string, width: number): void {
  const shape = appIconShape(icon);
  // Under bun's test DOM there is no Path2D; the canvas is a stub there and nothing reads its pixels.
  if (typeof Path2D === "undefined") return;
  const scale = (px - 2 * inset) / ICON_VIEWBOX;
  g.save();
  g.translate(inset, inset);
  g.scale(scale, scale);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = width / scale;
  for (const d of shape.paths) g.stroke(new Path2D(d));
  for (const [cx, cy, r] of shape.circles ?? []) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
  }
  for (const [cx, cy] of shape.dots ?? []) {
    g.beginPath();
    g.arc(cx, cy, 0.9 + (width - ICON_STROKE) / (2 * scale), 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** The app icon `icon` in `color`, outlined, as a MARKER_PX canvas (cached per icon and colour). */
export function markerImage(icon: string, color: string): MarkerImage {
  const id = `sighting-icon:${icon}:${color}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const image = createCanvas(MARKER_PX, MARKER_PX);
  const g = image.getContext("2d");
  if (g) {
    const inset = 4;
    strokeIcon(g, icon, MARKER_PX, inset, OUTLINE, OUTLINE_WIDTH);
    strokeIcon(g, icon, MARKER_PX, inset, color, ICON_STROKE + 0.4);
  }
  const made = { id, image };
  cache.set(id, made);
  return made;
}

/** A ring in `color` with a dark edge, as a RING_PX canvas (cached per colour). */
export function ringImage(color: string): MarkerImage {
  const id = `sighting-ring:${color}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const image = createCanvas(RING_PX, RING_PX);
  const g = image.getContext("2d");
  if (g) {
    const c = RING_PX / 2;
    g.beginPath();
    g.arc(c, c, c - 3, 0, Math.PI * 2);
    g.lineWidth = 5;
    g.strokeStyle = OUTLINE;
    g.stroke();
    g.beginPath();
    g.arc(c, c, c - 3, 0, Math.PI * 2);
    g.lineWidth = 2.5;
    g.strokeStyle = color;
    g.stroke();
  }
  const made = { id, image };
  cache.set(id, made);
  return made;
}

/** Test-only: how many images have been drawn so far. */
export function markerImageCount(): number {
  return cache.size;
}
