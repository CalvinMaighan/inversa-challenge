/**
 * Frame sightings in transit (PLAN.md C16). The SAB grid carries no sightings, so the db worker packs every
 * frame's raw records into one buffer that main (or a follower tab) turns into a `FrameSightings`, decoding
 * a frame's records on first use. Pure.
 */
import type { FrameSightings } from "client/threads/api";
import { readSightingRecords, SIGHTING_RECORD_BYTES, type SightingRecord } from "shared/frames";

export type SightingsPack = {
  /** Records per frame. */
  counts: Uint32Array;
  /** Record index where each frame starts; `offsets[frameCount]` is the total. */
  offsets: Uint32Array;
  /** Raw 16-byte records, frame after frame. */
  records: Uint8Array;
};

/** Pack per-frame raw record bytes (null = no data yet) into one transferable set of buffers. */
export function packSightings(perFrame: readonly (Uint8Array | null)[]): SightingsPack {
  const n = perFrame.length;
  const counts = new Uint32Array(n);
  const offsets = new Uint32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const c = Math.floor((perFrame[i]?.byteLength ?? 0) / SIGHTING_RECORD_BYTES);
    counts[i] = c;
    offsets[i] = total;
    total += c;
  }
  offsets[n] = total;
  const records = new Uint8Array(total * SIGHTING_RECORD_BYTES);
  for (let i = 0; i < n; i++) {
    const src = perFrame[i];
    if (src && counts[i]! > 0) records.set(src.subarray(0, counts[i]! * SIGHTING_RECORD_BYTES), offsets[i]! * SIGHTING_RECORD_BYTES);
  }
  return { counts, offsets, records };
}

/** Buffers to move with `postMessage` instead of cloning. */
export function packTransfer(p: SightingsPack): ArrayBuffer[] {
  return [p.counts.buffer, p.offsets.buffer, p.records.buffer].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
}

/** Deep copy for BroadcastChannel delivery to followers (the original stays attached). */
export function clonePack(p: SightingsPack): SightingsPack {
  return { counts: p.counts.slice(), offsets: p.offsets.slice(), records: p.records.slice() };
}

/** A `FrameSightings` over a pack; records decode once per frame and are cached. */
export function unpackSightings(p: SightingsPack): FrameSightings {
  const view = new DataView(p.records.buffer, p.records.byteOffset, p.records.byteLength);
  const cache = new Map<number, readonly SightingRecord[]>();
  const frameCount = p.counts.length;
  return {
    counts: p.counts,
    records(i) {
      if (!Number.isInteger(i) || i < 0 || i >= frameCount) return [];
      const hit = cache.get(i);
      if (hit) return hit;
      const out = readSightingRecords(view, p.offsets[i]! * SIGHTING_RECORD_BYTES, p.counts[i]!);
      cache.set(i, out);
      return out;
    },
  };
}

export function totalSightings(p: SightingsPack): number {
  return p.offsets[p.offsets.length - 1] ?? 0;
}
