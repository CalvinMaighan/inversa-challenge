/**
 * EVF2 walker (PLAN.md C4, `shared/frames.ts` layout): finds each frame's start and builds the three C16
 * publications from one buffer: the SAB FrameGrid, its FrameMeta, and the FrameSightings the grid does not
 * hold. Used by the globe's dev fixture; the db worker (T19) can reuse it.
 */
import { allocFrameGrid, writeFrameFromEvf, type FrameGrid } from "@calvinjs/active-state/threads";

import type { FrameMeta, FrameSightings } from "client/threads/api";
import {
  EVF_HEADER_BYTES,
  evfFrameBytes,
  evfFrameLayout,
  readEvfHeader,
  readSightingRecords,
  type EvfHeader,
  type SightingRecord,
} from "shared/frames";

export type EvfIndex = {
  header: EvfHeader;
  /** Byte offset of each frame body. */
  frameOffsets: number[];
  sightingCounts: Uint32Array;
};

/** Walk the frames of an EVF2 buffer. Throws on a bad magic or a truncated body. */
export function indexEvf(bytes: Uint8Array): EvfIndex {
  if (bytes.byteLength < EVF_HEADER_BYTES) throw new RangeError(`EVF: ${bytes.byteLength} bytes is shorter than the header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readEvfHeader(view);
  const layout = evfFrameLayout(header);
  const frameOffsets: number[] = [];
  const sightingCounts = new Uint32Array(header.frameCount);
  let offset = EVF_HEADER_BYTES;
  for (let i = 0; i < header.frameCount; i += 1) {
    const countAt = offset + layout.sightingsOffset;
    if (countAt + 4 > bytes.byteLength) throw new RangeError(`EVF: frame ${i} truncated at ${countAt}`);
    const n = view.getUint32(countAt, true);
    const size = evfFrameBytes(header, n);
    if (offset + size > bytes.byteLength) throw new RangeError(`EVF: frame ${i} needs ${size} bytes at ${offset}`);
    frameOffsets.push(offset);
    sightingCounts[i] = n;
    offset += size;
  }
  return { header, frameOffsets, sightingCounts };
}

/** Decoded sighting records of frame `i`. */
export function evfSightings(bytes: Uint8Array, index: EvfIndex, i: number): SightingRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = index.frameOffsets[i]! + evfFrameLayout(index.header).sightingsOffset + 4;
  return readSightingRecords(view, start, index.sightingCounts[i]!);
}

export function metaFromHeader(h: EvfHeader): FrameMeta {
  return {
    frame0UnixMs: h.frame0UnixMs,
    stepMinutes: h.stepMinutes,
    frameCount: h.frameCount,
    geometry: { west: h.west, south: h.south, hsCellDeg: h.hsCellDeg, envCellDeg: h.envCellDeg },
  };
}

/** FrameSightings over per-frame record lists. */
export function frameSightingsOf(lists: readonly (readonly SightingRecord[])[]): FrameSightings {
  const counts = Uint32Array.from(lists, (l) => l.length);
  return { counts, records: (i) => lists[i] ?? [] };
}

/** Grid, meta and sightings for every frame of an EVF2 buffer. Records decode once per frame, on first read. */
export function gridFromEvf(bytes: Uint8Array): { grid: FrameGrid; meta: FrameMeta; sightings: FrameSightings; index: EvfIndex } {
  const index = indexEvf(bytes);
  const h = index.header;
  const grid = allocFrameGrid({
    frameCount: h.frameCount,
    hsCols: h.hsCols,
    hsRows: h.hsRows,
    speciesCount: h.speciesCount,
    envCols: h.envCols,
    envRows: h.envRows,
    hotspotScale: h.hotspotScale,
  });
  index.frameOffsets.forEach((offset, i) => writeFrameFromEvf(grid, i, bytes, offset));
  grid.bump();
  const decoded = new Map<number, SightingRecord[]>();
  const sightings: FrameSightings = {
    counts: index.sightingCounts,
    records(i) {
      if (!Number.isInteger(i) || i < 0 || i >= h.frameCount) return [];
      let r = decoded.get(i);
      if (!r) {
        r = evfSightings(bytes, index, i);
        decoded.set(i, r);
      }
      return r;
    },
  };
  return { grid, meta: metaFromHeader(h), sightings, index };
}
