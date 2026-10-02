/**
 * Marker images for the sightings layer: a dot in the species' colour with a dark edge, so it reads on satellite
 * imagery in every theme. Drawn once per colour on a small canvas; Cesium keeps one texture-atlas region per image id
 * (`Billboard.setImage(id, canvas)`), so a thousand pythons share one dot; nothing is drawn per marker.
 */
import { createCanvas } from "./layers/raster-surface";

/** Marker canvas edge, px: the dot plus its edge, and the hit target (at least 24 px). */
export const MARKER_PX = 32;
/** Ring canvas edge, px: drawn around a selected marker (white) or a conflicting one (red). */
export const RING_PX = 44;
const OUTLINE = "#0b0d12";
/** The dot's radius, px (its edge is drawn outside it). */
const DOT_RADIUS = 5.5;

export type MarkerImage = { id: string; image: HTMLCanvasElement | string };

const cache = new Map<string, MarkerImage>();

/** A dot in `color`, outlined, as a MARKER_PX canvas (cached per colour). `icon` is unused: every app's markers are dots. */
export function markerImage(_icon: string, color: string): MarkerImage {
  const id = `sighting-dot:${color}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const image = createCanvas(MARKER_PX, MARKER_PX);
  const g = image.getContext("2d");
  if (g) {
    const c = MARKER_PX / 2;
    g.beginPath();
    g.arc(c, c, DOT_RADIUS, 0, Math.PI * 2);
    g.lineWidth = 3;
    g.strokeStyle = OUTLINE;
    g.stroke();
    g.fillStyle = color;
    g.fill();
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

/** A solid disc in `color`, as a RING_PX canvas: the pulse behind a selected dot is this, scaled up and faded out. */
export function pulseImage(color: string): MarkerImage {
  const id = `sighting-pulse:${color}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const image = createCanvas(RING_PX, RING_PX);
  const g = image.getContext("2d");
  if (g) {
    const c = RING_PX / 2;
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
  }
  const made = { id, image };
  cache.set(id, made);
  return made;
}

/** Test-only: how many images have been drawn so far. */
export function markerImageCount(): number {
  return cache.size;
}
