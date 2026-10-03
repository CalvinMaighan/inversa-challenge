/**
 * Layer contract (PRD §12 "Globe"): `init / enable / disable / update(frame) / stats`. Layers draw with
 * primitives only (never the Entity API), stamp each primitive with its C14 evidence id, and ask the render
 * governor for a frame after every change because the scene idles in requestRenderMode.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import type { LayerId, LayersState } from "client/state/layers";
import type { MissionsState } from "client/state/missions";
import type { NotePin } from "client/state/notes";
import type { Peer } from "client/state/peers";
import type { FrameMeta, GqlVariables } from "client/threads/api";
import type { SightingRecord } from "shared/frames";

import type { HoverFacts } from "../hover";

/** The slice of a Cesium widget a layer touches. A fake with an array-backed collection passes in tests. */
export type GlobeViewer = {
  scene: {
    primitives: {
      add<T>(primitive: T): T;
      remove(primitive: unknown): boolean;
    };
    /** GE5 raster overlays are Cesium imagery layers; absent on the test fake, where those layers report an error. */
    imageryLayers?: { add(layer: unknown, index?: number): void; remove(layer: unknown, destroy?: boolean): boolean };
    /** Fires with the number of globe tiles still loading; absent on the test fake. */
    globe?: { tileLoadProgressEvent?: { addEventListener(cb: (pending: number) => void): () => void } };
  };
  /** GE5: the credit line (`CesiumWidget.creditDisplay`); overlays register their attribution while on. */
  creditDisplay?: { addStaticCredit(credit: unknown): void; removeStaticCredit(credit: unknown): void };
};

export type LayerStats = {
  id: LayerId;
  enabled: boolean;
  /** Drawn items: points, cells or polygons, depending on the layer. */
  count: number;
  /** Frame index of the last update, -1 before the first. */
  frame: number;
  /** `performance.now()`-style ms of the last change on screen, or null. */
  updatedAt: number | null;
  error: string | null;
  /**
   * Drawn items split by what the legend shows per row: taxon ids for sightings, networks
   * for stations. Absent for layers the legend counts as a whole.
   */
  breakdown?: Record<string, number>;
  /**
   * How the sightings layer draws: icon billboards from one texture atlas, and how many plain dots (point
   * primitives) remain, which is none.
   */
  marker?: { kind: "billboard" | "point"; dots: number; images: number };
  /** GE5 overlays: the instant the layer shows (snapped to its source's cadence) and whether it was clamped to an edge. */
  overlay?: { shownMs: number; clamped: "latest" | "earliest" | null; opacity: number };
  /**
   * Vessels layer (GE4): the time the ships are drawn at (unix ms), trails drawn, and up to 200 drawn positions by
   * MMSI as [lon, lat], so a check can see ships move between two timeline times.
   */
  vessels?: { atMs: number; trails: number; positions: Record<string, readonly [number, number]> };
};

/** What layers read besides the frame grid. The globe wires it to active-state and the threads API. */
export type LayerContext = {
  requestRender(): void;
  now(): number;
  /** TIME cursor, unix ms. */
  timeMs(): number;
  playing(): boolean;
  /** Time axis and placement of the published grid (C16), or null before one is published. */
  meta(): FrameMeta | null;
  /** Decoded EVF2 sighting records of frame `i` (C16 FrameSightings); empty when none are published. */
  sightings(frame: number): readonly SightingRecord[];
  /** Bumped whenever a grid, meta or sightings set is published, so layers can key redraws on it. */
  revision(): number;
  layers(): LayersState;
  /** Selected evidence id (SELECTION), for layers that emphasise it. Optional for stand-in contexts. */
  selection?(): string | null;
  missions(): MissionsState;
  peers(): readonly Peer[];
  /** Live field notes on the team board (NOTES.pins, T43). */
  notes(): readonly NotePin[];
  gql<T>(query: string, variables?: GqlVariables, signal?: AbortSignal): Promise<T>;
};

/** Ids of primitives that stand for a whole raster; `pick` resolves them through `pickAt`. */
export const RASTER_PICK_PREFIX = "raster:";

export interface GlobeLayer {
  readonly id: LayerId;
  init(viewer: GlobeViewer): void;
  enable(): void;
  disable(): void;
  /**
   * Bring the layer to `frameIndex` (-1: no frame) of `grid` (null: none published). Called on every frame,
   * filter or data change; a layer skips work when its inputs are unchanged.
   */
  update(frameIndex: number, grid: FrameGrid | null): void;
  stats(): LayerStats;
  /** Evidence id for a globe position, for rasters whose single primitive covers many cells. */
  pickAt?(lon: number, lat: number): string | null;
  /** What one of this layer's evidence ids stands for, from what it drew (hover tooltips); null when not its own. */
  describe?(id: string): HoverFacts | null;
  destroy(): void;
}
