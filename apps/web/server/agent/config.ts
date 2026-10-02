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
