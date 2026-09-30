import { resolve } from "node:path";

/** PLAN.md C13. Axum's loopback origin unless INVERSA_API_ORIGIN says otherwise. */
export function apiOrigin(): string {
  return (process.env.INVERSA_API_ORIGIN?.trim() || "http://127.0.0.1:4041").replace(/\/$/, "");
}

/** PLAN.md C13: `INVERSA_DATA_DIR`, default `./data`. Resolved against cwd. */
export function dataDir(): string {
  // Runtime-only path: keep Turbopack from tracing the whole project into the server bundle.
  return resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.INVERSA_DATA_DIR?.trim() || "data");
}

/** PLAN.md C15 region bbox. Tool defaults and clamps use it. */
export const REGION_BBOX = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 } as const;

/** PLAN.md C14 grid: 0.01° cells anchored at the region's south-west corner. */
export const CELL_DEG = 0.01;
