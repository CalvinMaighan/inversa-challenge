/**
 * `window.__inversa`: diagnostics for development builds and e2e builds (`NEXT_PUBLIC_INVERSA_E2E=1` at build
 * time). Production builds leave `DEBUG_HOOK` false and the bundler drops the hook. Everything here reads; the
 * e2e scripts drive the app through its real UI and URL, never through this object.
 */
import { get } from "@calvinjs/active-state";

import { getGlobe, type ScreenPoint } from "client/globe/api";
import type { GlobeHandle } from "client/globe/viewer";
import type { StateKeyId } from "client/state";
import { TIME, type TimeState } from "client/state/time";
import { threadsBooted } from "client/threads/boot";
import { frameIndexAt, getFrameGrid, getFrameMeta, getFrameSightings } from "client/threads/api";
import { EVF_SPECIES, SIGHTING_FLAG } from "shared/frames";

export const DEBUG_HOOK = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_INVERSA_E2E === "1";

export type InversaSnapshot = {
  isolated: boolean;
  transport: string | null;
  leader: string | null;
  grid: { frameCount: number; version: number; shared: boolean } | null;
  meta: ReturnType<typeof getFrameMeta>;
  /** Sighting records across the grid's frames. */
  sightings: number;
  /** Frame index of the TIME cursor, or null outside the grid. */
  frame: number | null;
};

export type InversaDebug = {
  snapshot(): InversaSnapshot;
  /** A catalog key's current value (TIME, VIEW, SELECTION, FEEDS ...). */
  state(key: StateKeyId): unknown;
  /** Hotspot score at a place for the frame covering `atIso`; null outside the grid. */
  hotspotAt(atIso: string, species: (typeof EVF_SPECIES)[number], lon: number, lat: number): number | null;
  /** Highest hotspot score of one species in the frame covering `atIso`. */
  maxHotspot(atIso: string, species: (typeof EVF_SPECIES)[number]): number | null;
  /** Sighting ids in the frame covering `atIso`. */
  sightingIds(atIso: string): number[];
  /** Sighting records (id, EVF taxon, position) in the frame covering `atIso`, duplicates left out. */
  sightingRecords(atIso: string): { id: number; taxon: number; lon: number; lat: number }[];
  /** Globe: screen point of a place, the evidence id under a point, layer stats and render diagnostics. */
  project(lon: number, lat: number): ScreenPoint | null;
  pick(x: number, y: number): string | null;
  globe(): ReturnType<GlobeHandle["diagnostics"]> | null;
};

declare global {
  interface Window {
    __inversa?: InversaDebug;
  }
}

let globeHandle: GlobeHandle | null = null;

/** GlobeView hands over its handle (null on unmount) so the hook can report layer stats. */
export function setDebugGlobe(handle: GlobeHandle | null): void {
  if (DEBUG_HOOK) globeHandle = handle;
}

function frameAt(atIso: string): number | null {
  const ms = Date.parse(atIso);
  return Number.isFinite(ms) ? frameIndexAt(ms) : null;
}

export function installDebugHook(): void {
  if (!DEBUG_HOOK || typeof window === "undefined" || window.__inversa) return;
  window.__inversa = {
    snapshot() {
      const grid = getFrameGrid();
      const sightings = getFrameSightings();
      const threads = threadsBooted();
      const time = { ...TIME.defaults, ...get<TimeState>(TIME) };
      return {
        isolated: window.crossOriginIsolated,
        transport: threads?.transport ?? null,
        leader: threads?.leaderState() ?? null,
        grid: grid
          ? { frameCount: grid.shape.frameCount, version: grid.version(), shared: typeof SharedArrayBuffer === "function" && grid.buffer instanceof SharedArrayBuffer }
          : null,
        meta: getFrameMeta(),
        sightings: sightings ? sightings.counts.reduce((a, b) => a + b, 0) : 0,
        frame: frameAt(time.at),
      };
    },
    state: (key) => get(key),
    hotspotAt(atIso, species, lon, lat) {
      const grid = getFrameGrid();
      const meta = getFrameMeta();
      const i = frameAt(atIso);
      const s = EVF_SPECIES.indexOf(species);
      if (!grid || !meta || i === null || s < 0) return null;
      const col = Math.floor((lon - meta.geometry.west) / meta.geometry.hsCellDeg);
      const row = Math.floor((lat - meta.geometry.south) / meta.geometry.hsCellDeg);
      if (col < 0 || row < 0 || col >= grid.shape.hsCols || row >= grid.shape.hsRows) return null;
      return grid.hotspot(i, s)[row * grid.shape.hsCols + col]! * grid.hotspotScale;
    },
    maxHotspot(atIso, species) {
      const grid = getFrameGrid();
      const i = frameAt(atIso);
      const s = EVF_SPECIES.indexOf(species);
      if (!grid || i === null || s < 0) return null;
      let max = 0;
      for (const v of grid.hotspot(i, s)) if (v > max) max = v;
      return max * grid.hotspotScale;
    },
    sightingIds(atIso) {
      const i = frameAt(atIso);
      const sightings = getFrameSightings();
      if (i === null || !sightings || i >= sightings.counts.length) return [];
      return sightings.records(i).map((r) => r.id);
    },
    sightingRecords(atIso) {
      const i = frameAt(atIso);
      const sightings = getFrameSightings();
      if (i === null || !sightings || i >= sightings.counts.length) return [];
      return sightings
        .records(i)
        .filter((r) => !(r.flags & SIGHTING_FLAG.duplicate))
        .map((r) => ({ id: r.id, taxon: r.taxon, lon: r.lon, lat: r.lat }));
    },
    project: (lon, lat) => getGlobe()?.project(lon, lat) ?? null,
    pick: (x, y) => getGlobe()?.pick(x, y) ?? null,
    globe: () => globeHandle?.diagnostics() ?? null,
  };
}
