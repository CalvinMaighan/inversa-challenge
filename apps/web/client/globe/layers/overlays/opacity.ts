/**
 * One opacity for every water and weather overlay (GE5): the slider in the Layers popover writes it, the raster
 * layers read it. A tiny store rather than an active-state key: it is a look preference, not shared state, and
 * never travels in a share link.
 */
import { DEFAULT_OVERLAY_OPACITY } from "shared/overlays";

let opacity = DEFAULT_OVERLAY_OPACITY;
const listeners = new Set<() => void>();

export function overlayOpacity(): number {
  return opacity;
}

/** Clamped to 0.05..1 so a layer never vanishes behind its own slider. */
export function setOverlayOpacity(value: number): void {
  const next = Math.min(1, Math.max(0.05, Number.isFinite(value) ? value : DEFAULT_OVERLAY_OPACITY));
  if (next === opacity) return;
  opacity = next;
  for (const cb of listeners) cb();
}

export function subscribeOverlayOpacity(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
