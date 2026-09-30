/**
 * EVF2 walker (PLAN.md C4, `shared/frames.ts` layout): finds each frame's start, and decodes the sighting
 * records the FrameGrid does not hold. Used by the dev fixture to load `spec/frames/sample.evf`; the db worker
 * (T19) can use the same functions.
 */
import { allocFrameGrid, writeFrameFromEvf, type FrameGrid } from "@calvinjs/active-state/threads";

import { EVF_HEADER_BYTES, evfFrameBytes, evfFrameLayout, readEvfHeader, SIGHTING_RECORD_BYTES, type EvfHeader } from "shared/frames";

import type { SightingRecord } from "./api";

export type EvfIndex = {
  header: EvfHeader;
  /** Byte offset of each frame body. */
  frameOffsets: number[];
  sightingCounts: number[];
};

/** Walk the frames of an EVF2 buffer. Throws on a bad magic or a truncated body. */
export function indexEvf(bytes: Uint8Array): EvfIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < EVF_HEADER_BYTES) throw new RangeError(`EVF: ${bytes.byteLength} bytes is shorter than the header`);
  const header = readEvfHeader(view);
  const layout = evfFrameLayout(header);
  const frameOffsets: number[] = [];
  const sightingCounts: number[] = [];
  let offset = EVF_HEADER_BYTES;
  for (let i = 0; i < header.frameCount; i += 1) {
    const countAt = offset + layout.sightingsOffset;
    if (countAt + 4 > bytes.byteLength) throw new RangeError(`EVF: frame ${i} truncated at ${countAt}`);
    const n = view.getUint32(countAt, true);
    const size = evfFrameBytes(header, n);
    if (offset + size > bytes.byteLength) throw new RangeError(`EVF: frame ${i} needs ${size} bytes at ${offset}`);
    frameOffsets.push(offset);
    sightingCounts.push(n);
    offset += size;
  }
  return { header, frameOffsets, sightingCounts };
}

/** Sighting records of frame `i`. */
export function evfSightings(bytes: Uint8Array, index: EvfIndex, i: number): SightingRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = index.frameOffsets[i]! + evfFrameLayout(index.header).sightingsOffset + 4;
  const out: SightingRecord[] = [];
  for (let k = 0; k < index.sightingCounts[i]!; k += 1) {
    const at = start + k * SIGHTING_RECORD_BYTES;
    out.push({
      lon: view.getFloat32(at, true),
      lat: view.getFloat32(at + 4, true),
      taxon: view.getUint16(at + 8, true),
      quality: view.getUint8(at + 10),
      flags: view.getUint8(at + 11),
    });
  }
  return out;
}

/** A SAB FrameGrid holding every frame of `bytes`, plus per-frame sighting lists. */
export function gridFromEvf(bytes: Uint8Array): { grid: FrameGrid; index: EvfIndex; sightings: SightingRecord[][] } {
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
  const sightings: SightingRecord[][] = [];
  index.frameOffsets.forEach((offset, i) => {
    writeFrameFromEvf(grid, i, bytes, offset);
    sightings.push(evfSightings(bytes, index, i));
  });
  grid.bump();
  return { grid, index, sightings };
}
