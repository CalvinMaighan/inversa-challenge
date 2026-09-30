/**
 * Per-frame sighting counts for the sparkline and the quiet-run gap rule.
 *
 * The SAB frame grid (PLAN.md C16) keeps each frame's fixed part only; the variable-length sighting section of
 * an EVF2 frame stays with the decoder. Whoever decodes EVF2 (the db worker boot, T19; the dev fixture) reads
 * the counts with `evfSightingCounts` and publishes them here, aligned to the grid's frame indices.
 */
import { EVF_HEADER_BYTES, evfFrameLayout, readEvfHeader, SIGHTING_RECORD_BYTES, type EvfHeader } from "shared/frames";

import { cell } from "../store";

/** Counts aligned with the published FrameGrid, or null until a decoder publishes them. */
export const sightingCounts = cell<Uint32Array | null>(null);

export function publishSightingCounts(counts: Uint32Array | null): void {
  sightingCounts.set(counts);
}

/**
 * Walk an EVF2 buffer (PLAN.md C4): each frame's byte offset and sighting count. Frames vary in length (the
 * sighting section), so this is the only way to find frame `i`. Throws on a truncated buffer: a count read
 * from past the end would be garbage, and a silent zero would draw a false quiet gap.
 */
export function evfFrames(bytes: Uint8Array): { header: EvfHeader; offsets: Uint32Array; counts: Uint32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readEvfHeader(view);
  const { sightingsOffset } = evfFrameLayout(header);
  const offsets = new Uint32Array(header.frameCount);
  const counts = new Uint32Array(header.frameCount);
  let offset = EVF_HEADER_BYTES;
  for (let f = 0; f < header.frameCount; f++) {
    offsets[f] = offset;
    const countAt = offset + sightingsOffset;
    if (countAt + 4 > bytes.byteLength) throw new RangeError(`EVF: frame ${f} truncated at ${countAt}`);
    const n = view.getUint32(countAt, true);
    counts[f] = n;
    offset = countAt + 4 + n * SIGHTING_RECORD_BYTES;
    if (offset > bytes.byteLength) throw new RangeError(`EVF: frame ${f} sightings truncated`);
  }
  return { header, offsets, counts };
}

export function evfSightingCounts(bytes: Uint8Array): Uint32Array {
  return evfFrames(bytes).counts;
}
