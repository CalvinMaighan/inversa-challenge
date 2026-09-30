/**
 * Globe API contract (PLAN.md C16). T17 implements the Cesium side and calls `registerGlobe`;
 * the HUD (T18), missions (T21) and agent card (T14) consume it without importing Cesium.
 */

export type CameraTarget = {
  lon: number;
  lat: number;
  altitudeM?: number;
  heading?: number;
  pitch?: number;
  durationS?: number;
};

export type ScreenPoint = { x: number; y: number };

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
  /** Globe position under the pointer as it moves (null when it leaves the globe); for the top bar and peers. */
  onCursor(cb: (at: GeoPoint | null) => void): () => void;
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

/**
 * One EVF2 sighting record (PLAN.md C4), plus the `sightings.id` when the publisher knows it. EVF2 records do
 * not carry ids; the sightings layer fills them from GraphQL for the frame on screen while paused.
 */
export type SightingRecord = {
  lon: number;
  lat: number;
  /** `taxa.id`; 1–4 are the focus species in SPECIES_IDS order. */
  taxon: number;
  /** Index into QUALITY_CODES. */
  quality: number;
  /** SIGHTING_FLAG bits. */
  flags: number;
  id?: string;
};

/**
 * What the `FrameGrid` (C16) does not carry: when frame 0 starts, the step, and the per-frame sighting
 * records that follow each EVF2 frame's fixed part. Published next to the grid by whoever fills it (the db
 * worker boot code, T19; the dev fixture until then).
 */
export type FrameTimeline = {
  frame0Ms: number;
  stepMs: number;
  frameCount: number;
  sightings(frame: number): readonly SightingRecord[];
  /** Grid placement from the EVF2 header; omitted means the C4 layout over the C15 region. */
  geometry?: GridGeometry;
};

/** South-west corner and cell sizes, degrees (EVF2 header `west`, `south`, `hsCellDeg`, `envCellDeg`). */
export type GridGeometry = { west: number; south: number; hsCellDeg: number; envCellDeg: number };

let timeline: FrameTimeline | null = null;
const timelineListeners = new Set<(t: FrameTimeline) => void>();

export function publishFrameTimeline(next: FrameTimeline): void {
  timeline = next;
  for (const cb of timelineListeners) cb(next);
}

export function getFrameTimeline(): FrameTimeline | null {
  return timeline;
}

export function onFrameTimeline(cb: (t: FrameTimeline) => void): () => void {
  if (timeline) cb(timeline);
  timelineListeners.add(cb);
  return () => timelineListeners.delete(cb);
}
