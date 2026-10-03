/**
 * Globe API contract (PLAN.md C16). T17 implements the Cesium side and calls `registerGlobe`;
 * the HUD (T18), missions (T21), the agent column (T14/T40) and the legend and tooltips (T40) consume it
 * without importing Cesium.
 */
import type { HoverFacts } from "./hover";
import type { LayerStats } from "./layers/types";

export type CameraTarget = {
  lon: number;
  lat: number;
  altitudeM?: number;
  heading?: number;
  pitch?: number;
  durationS?: number;
};

export type ScreenPoint = { x: number; y: number };

/** A picture laid over the globe by `GlobeApi.drape`. */
export type DrapedImage = {
  setAlpha(alpha: number): void;
  /** Stops loading it if it has not arrived, and takes it off the globe. */
  remove(): void;
  /** Settles when the picture is on the globe or could not be loaded (never rejects). */
  ready: Promise<void>;
};

export type GeoPoint = { lon: number; lat: number };

export type GlobeApi = {
  flyTo(target: CameraTarget): void;
  /** Screen position in CSS px, or null when behind the globe or off screen. */
  project(lon: number, lat: number): ScreenPoint | null;
  /** Evidence id (PLAN.md C14) of the primitive under a screen point, if any. */
  pick(x: number, y: number): string | null;
  /** Fires after each rendered frame; use for HUD overlays that track entities. */
  onPostRender(cb: () => void): () => void;
  requestRender(): void;
  /**
   * Globe position under the pointer as it moves (null when it leaves the globe), for the top bar and peer
   * cursors. Optional so stand-in globes (dev fixtures, tests) need not implement it; the Cesium globe does.
   */
  onCursor?(cb: (at: GeoPoint | null) => void): () => void;
  /**
   * Per-layer draw stats (enabled, count, per-species or per-network breakdown) for the Layers legend (T40).
   * Optional for stand-in globes; the Cesium globe implements it.
   */
  stats?(): LayerStats[];
  /**
   * Lay one picture over the globe as imagery, pinned to a lon/lat rectangle (it follows the globe's curve, unlike a
   * picture drawn on a flat canvas). Optional for stand-in globes; the Cesium globe implements it.
   */
  drape?(spec: { url: string; west: number; south: number; east: number; north: number; alpha: number }): DrapedImage;
  /** What an evidence id from `pick` stands for, from what its layer drew (hover tooltips); null if unknown. */
  describe?(id: string): HoverFacts | null;
};

let current: GlobeApi | null = null;
const readyListeners = new Set<(api: GlobeApi) => void>();

export function registerGlobe(api: GlobeApi | null): void {
  current = api;
  if (api) for (const cb of readyListeners) cb(api);
}

export function getGlobe(): GlobeApi | null {
  return current;
}

/** Calls `cb` now if the globe is up, else once it registers. Returns an unsubscribe. */
export function onGlobeReady(cb: (api: GlobeApi) => void): () => void {
  if (current) cb(current);
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}
