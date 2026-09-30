/**
 * Layer contract (PRD §12 "Globe"): `init / enable / disable / update(frame) / stats`. Layers draw with
 * primitives only (never the Entity API), stamp each primitive with its C14 evidence id, and ask the render
 * governor for a frame after every change because the scene idles in requestRenderMode.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import type { LayerId, LayersState } from "client/state/layers";
import type { MissionsState } from "client/state/missions";
import type { Peer } from "client/state/peers";
import type { GqlVariables } from "client/threads/api";

import type { FrameTimeline } from "../api";

/** The slice of a Cesium widget a layer touches. A fake with an array-backed collection passes in tests. */
export type GlobeViewer = {
  scene: {
    primitives: {
      add<T>(primitive: T): T;
      remove(primitive: unknown): boolean;
    };
  };
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
};

/** What layers read besides the frame grid. The globe wires it to active-state and the threads API. */
export type LayerContext = {
  requestRender(): void;
  now(): number;
  /** TIME cursor, unix ms. */
  timeMs(): number;
  playing(): boolean;
  /** Frame timing and sightings for the published grid, or an assumed timeline. */
  timeline(): FrameTimeline | null;
  layers(): LayersState;
  missions(): MissionsState;
  peers(): readonly Peer[];
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
  destroy(): void;
}
