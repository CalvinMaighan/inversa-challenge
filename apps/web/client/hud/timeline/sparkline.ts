/**
 * Sighting-density sparkline: per-frame sighting counts (from the EVF2 sighting sections, PLAN.md C4) summed
 * into pixel buckets. With `B ≤ n` buckets, bucket `b` covers frames `[floor(b·n/B), floor((b+1)·n/B))`, so
 * every frame lands in exactly one bucket and the buckets add up to the total. With more buckets than frames,
 * a frame spans several buckets and each shows that frame's count, so no bucket reads empty between frames.
 */
import { speciesIndexOfTaxon } from "client/globe/species";
import { SIGHTING_FLAG, type SightingRecord } from "shared/frames";

export type Buckets = { values: Float64Array; max: number; total: number };

/**
 * Per-frame sightings the globe would draw: duplicates left out (their canonical record stands for them), focus
 * species by the filter's indices, other taxa by `other`. The sparkline follows the species bar with this.
 */
export function filteredCounts(frameCount: number, records: (frame: number) => readonly SightingRecord[], species: readonly number[], other: boolean): Uint32Array {
  const on = new Set(species);
  const out = new Uint32Array(Math.max(0, frameCount));
  for (let f = 0; f < out.length; f++) {
    let n = 0;
    for (const r of records(f)) {
      if (r.flags & SIGHTING_FLAG.duplicate) continue;
      const s = speciesIndexOfTaxon(r.taxon);
      if (s < 0 ? other : on.has(s)) n += 1;
    }
    out[f] = n;
  }
  return out;
}

export function bucketCounts(counts: ArrayLike<number>, bucketCount: number): Buckets {
  const b = Math.max(0, Math.floor(bucketCount));
  const n = counts.length;
  const values = new Float64Array(b);
  let total = 0;
  for (let i = 0; i < n; i++) total += counts[i];
  if (b === 0 || n === 0) return { values, max: 0, total };

  if (b <= n) {
    for (let k = 0; k < b; k++) {
      const start = Math.floor((k * n) / b);
      const end = Math.floor(((k + 1) * n) / b);
      let sum = 0;
      for (let i = start; i < end; i++) sum += counts[i];
      values[k] = sum;
    }
  } else {
    for (let k = 0; k < b; k++) values[k] = counts[Math.min(n - 1, Math.floor((k * n) / b))];
  }
  let max = 0;
  for (let k = 0; k < b; k++) if (values[k] > max) max = values[k];
  return { values, max, total };
}

/**
 * Bucket values → canvas y (0 at the top). A square-root scale keeps a quiet week visible next to a busy
 * afternoon; an empty series draws a flat baseline.
 */
export function sparkY(value: number, max: number, height: number): number {
  if (max <= 0) return height;
  return height - Math.sqrt(value / max) * height;
}
