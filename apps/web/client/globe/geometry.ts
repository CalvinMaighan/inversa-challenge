/**
 * Where a frame grid sits on the map. The FrameGrid carries only cell counts; `FrameMeta.geometry` (C16, from
 * the EVF2 header) carries the south-west corner and cell sizes. Without meta the grid is taken to be the C4
 * layout (south-west corner −83.2, 24.3; 0.02° hotspot cells, 0.05° environment cells).
 */
import type { GridShape } from "@calvinjs/active-state/threads";

import type { FrameMeta } from "client/threads/api";
import type { BBox } from "shared/agent/events";

export type GridGeometry = FrameMeta["geometry"];

/** PLAN.md C4's fixed EVF2 layout, the fallback for a header without geometry. */
export const C4_GEOMETRY: Readonly<GridGeometry> = Object.freeze({
  west: -83.2,
  south: 24.3,
  hsCellDeg: 0.02,
  envCellDeg: 0.05,
});

/** The extent of the C4 grid (170 × 160 hotspot cells): what the dev fixtures draw, whatever app is active. */
export const C4_BBOX: Readonly<BBox> = Object.freeze({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 });

export type GridBounds = { hotspot: BBox; env: BBox };

const box = (west: number, south: number, cols: number, rows: number, deg: number): BBox => ({
  west,
  south,
  east: west + cols * deg,
  north: south + rows * deg,
});

export function gridBounds(shape: Pick<GridShape, "hsCols" | "hsRows" | "envCols" | "envRows">, geometry: GridGeometry | undefined): GridBounds {
  const g = geometry ?? C4_GEOMETRY;
  return {
    hotspot: box(g.west, g.south, shape.hsCols, shape.hsRows, g.hsCellDeg),
    env: box(g.west, g.south, shape.envCols, shape.envRows, g.envCellDeg),
  };
}

/** `[col, row]` of the cell containing a point, or null outside `bounds`. */
export function cellAt(bounds: BBox, cols: number, rows: number, lon: number, lat: number): [number, number] | null {
  const col = Math.floor(((lon - bounds.west) / (bounds.east - bounds.west)) * cols);
  const row = Math.floor(((lat - bounds.south) / (bounds.north - bounds.south)) * rows);
  return col < 0 || row < 0 || col >= cols || row >= rows ? null : [col, row];
}

export const boundsKey = (b: BBox) => `${b.west},${b.south},${b.east},${b.north}`;
