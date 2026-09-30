/**
 * Frame window and EVF2 -> FrameGrid mapping for the db worker (PLAN.md C4, C16). Pure.
 *
 * The resident grid covers the TIME window with two densities: hourly frames from `from` up to 24 h before
 * `to`, then 15-minute frames to `to`. Frame `i` is `frameAtIndex(w, i)`; the globe maps TIME to an index
 * with `frameIndexAt`. Both are total over the window, so a scrub never reads outside the buffer.
 */
import {
  attachFrameGrid,
  frameGridBytes,
  GRID_HEADER_BYTES,
  GRID_MAGIC,
  writeFrameFromEvf,
  type FrameGrid,
  type GridShape,
} from "@calvinjs/active-state/threads";

import { EVF_HEADER_BYTES, evfFrameBytes, evfFrameLayout, readEvfHeader, type EvfHeader } from "shared/frames";

export const COARSE_STEP_MINUTES = 60;
export const FINE_STEP_MINUTES = 15;
/** The trailing span held at the fine step. */
export const FINE_SPAN_MS = 24 * 60 * 60_000;

const COARSE_MS = COARSE_STEP_MINUTES * 60_000;
const FINE_MS = FINE_STEP_MINUTES * 60_000;

export type FrameWindow = {
  fromMs: number;
  toMs: number;
  /** First hourly frame (the first hour boundary at or after `fromMs`). */
  coarseStartMs: number;
  /** Where the fine part starts: `toMs - FINE_SPAN_MS`, or `fromMs` for short windows. */
  splitMs: number;
  coarseCount: number;
  fineCount: number;
  frameCount: number;
};

const toMs = (t: string | number): number => (typeof t === "number" ? t : Date.parse(t));

/** Window for a TIME `{from, to}` pair; `to` should sit on a 15-minute step. */
export function frameWindow(from: string | number, to: string | number): FrameWindow {
  const fromMs = toMs(from);
  const endMs = toMs(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(endMs)) throw new Error(`frameWindow: bad bounds ${String(from)}..${String(to)}`);
  if (endMs < fromMs) throw new Error("frameWindow: to before from");
  const splitMs = Math.max(fromMs, endMs - FINE_SPAN_MS);
  const coarseStartMs = Math.ceil(fromMs / COARSE_MS) * COARSE_MS;
  const coarseCount = Math.max(0, Math.ceil((splitMs - coarseStartMs) / COARSE_MS));
  const fineCount = Math.floor((endMs - splitMs) / FINE_MS) + 1;
  return { fromMs, toMs: endMs, coarseStartMs, splitMs, coarseCount, fineCount, frameCount: coarseCount + fineCount };
}

export function frameAtIndex(w: FrameWindow, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= w.frameCount) throw new RangeError(`frame index ${index} outside [0, ${w.frameCount})`);
  return index < w.coarseCount ? w.coarseStartMs + index * COARSE_MS : w.splitMs + (index - w.coarseCount) * FINE_MS;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Index of the frame at or before `atMs`, clamped into the window. */
export function frameIndexAt(w: FrameWindow, atMs: number): number {
  if (w.frameCount === 0) return -1;
  if (atMs >= w.splitMs || w.coarseCount === 0) {
    return clamp(w.coarseCount + Math.floor((atMs - w.splitMs) / FINE_MS), w.coarseCount, w.frameCount - 1);
  }
  return clamp(Math.floor((atMs - w.coarseStartMs) / COARSE_MS), 0, w.coarseCount - 1);
}

/** Index of a frame whose timestamp lands exactly on the grid, else -1. */
export function frameIndexExact(w: FrameWindow, atMs: number): number {
  if (atMs >= w.splitMs) {
    if (atMs > w.toMs || (atMs - w.splitMs) % FINE_MS !== 0) return -1;
    return w.coarseCount + (atMs - w.splitMs) / FINE_MS;
  }
  if (atMs < w.coarseStartMs || (atMs - w.coarseStartMs) % COARSE_MS !== 0) return -1;
  const i = (atMs - w.coarseStartMs) / COARSE_MS;
  return i < w.coarseCount ? i : -1;
}

export function frameStepMinutes(w: FrameWindow, index: number): number {
  return index < w.coarseCount ? COARSE_STEP_MINUTES : FINE_STEP_MINUTES;
}

export type ChunkRequest = { fromMs: number; toMs: number; stepMinutes: number };

/** REST caps one response at 744 frames (C4). */
export const MAX_CHUNK_FRAMES = 744;

/**
 * Requests that fill every frame in `w` not in `present` (a set of frame timestamps), as few contiguous
 * ranges as possible, each within the REST cap.
 */
export function missingChunks(w: FrameWindow, present: ReadonlySet<number>): ChunkRequest[] {
  const out: ChunkRequest[] = [];
  let run: ChunkRequest | null = null;
  const flush = () => {
    if (run) out.push(run);
    run = null;
  };
  for (let i = 0; i < w.frameCount; i++) {
    const at = frameAtIndex(w, i);
    const step = frameStepMinutes(w, i);
    if (present.has(at)) {
      flush();
      continue;
    }
    const stepMs = step * 60_000;
    if (run && run.stepMinutes === step && run.toMs + stepMs === at && (run.toMs - run.fromMs) / stepMs + 1 < MAX_CHUNK_FRAMES) {
      run.toMs = at;
    } else {
      flush();
      run = { fromMs: at, toMs: at, stepMinutes: step };
    }
  }
  flush();
  return out;
}

/** Every frame of `w` at its own step: what a full refetch asks for. */
export function allChunks(w: FrameWindow): ChunkRequest[] {
  return missingChunks(w, new Set());
}

/** Restrict a refetch to the frames of `w` inside `[fromMs, toMs]` (a `framesUpdated` range). */
export function chunksWithin(w: FrameWindow, fromMs: number, toMs: number): ChunkRequest[] {
  const present = new Set<number>();
  for (let i = 0; i < w.frameCount; i++) {
    const at = frameAtIndex(w, i);
    if (at < fromMs || at > toMs) present.add(at);
  }
  return missingChunks(w, present);
}

export function chunkUrl(base: string, c: ChunkRequest): string {
  const q = new URLSearchParams({ from: new Date(c.fromMs).toISOString(), to: new Date(c.toMs).toISOString(), step: String(c.stepMinutes) });
  return `${base}?${q.toString()}`;
}

// ---- EVF2 ----------------------------------------------------------------------------------

export type EvfFrame = { atMs: number; offset: number; sightingCount: number; byteLength: number };

export type ParsedEvf = { header: EvfHeader; frames: EvfFrame[] };

/** Walk an EVF2 body; throws on a truncated frame. */
export function parseEvf(bytes: Uint8Array): ParsedEvf {
  if (bytes.byteLength < EVF_HEADER_BYTES) throw new Error(`EVF: ${bytes.byteLength} bytes is shorter than the header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readEvfHeader(view);
  const layout = evfFrameLayout(header);
  const frames: EvfFrame[] = [];
  let offset = EVF_HEADER_BYTES;
  const stepMs = header.stepMinutes * 60_000;
  for (let i = 0; i < header.frameCount; i++) {
    const countAt = offset + layout.sightingsOffset;
    if (countAt + 4 > bytes.byteLength) throw new Error(`EVF: frame ${i} truncated at ${offset}`);
    const sightingCount = view.getUint32(countAt, true);
    const byteLength = evfFrameBytes(header, sightingCount);
    if (offset + byteLength > bytes.byteLength) throw new Error(`EVF: frame ${i} needs ${byteLength} bytes at ${offset}, have ${bytes.byteLength - offset}`);
    frames.push({ atMs: header.frame0UnixMs + i * stepMs, offset, sightingCount, byteLength });
    offset += byteLength;
  }
  return { header, frames };
}

export function gridShapeFor(h: EvfHeader, frameCount: number): GridShape {
  return {
    frameCount,
    hsCols: h.hsCols,
    hsRows: h.hsRows,
    speciesCount: h.speciesCount,
    envCols: h.envCols,
    envRows: h.envRows,
    hotspotScale: h.hotspotScale,
  };
}

export function sameGridShape(a: GridShape, b: GridShape): boolean {
  return (
    a.frameCount === b.frameCount &&
    a.hsCols === b.hsCols &&
    a.hsRows === b.hsRows &&
    a.speciesCount === b.speciesCount &&
    a.envCols === b.envCols &&
    a.envRows === b.envRows &&
    Math.abs(a.hotspotScale - b.hotspotScale) < 1e-6
  );
}

/**
 * Grid header as `allocFrameGrid` writes it (active-state `bulk.ts`): twelve i32 slots, `hotspotScale` as f32
 * in slot 8. Written here too so a grid can live in a plain ArrayBuffer when SharedArrayBuffer is gated.
 */
function writeGridHeader(buffer: ArrayBufferLike, shape: GridShape): void {
  const hdr = new Int32Array(buffer, 0, GRID_HEADER_BYTES / 4);
  hdr[0] = GRID_MAGIC;
  hdr[1] = 0;
  hdr[2] = shape.frameCount;
  hdr[3] = shape.hsCols;
  hdr[4] = shape.hsRows;
  hdr[5] = shape.speciesCount;
  hdr[6] = shape.envCols;
  hdr[7] = shape.envRows;
  new Float32Array(buffer, 8 * 4, 1)[0] = shape.hotspotScale;
}

/**
 * Allocate a grid over a SharedArrayBuffer when the runtime allows one, else over an ArrayBuffer that the
 * worker transfers to main. Both attach through `attachFrameGrid`: typed-array views and `Atomics.load/add`
 * work on either buffer kind, only cross-thread waiting needs the shared one.
 */
export function allocGrid(shape: GridShape, shared: boolean): FrameGrid {
  const bytes = frameGridBytes(shape);
  const buffer = shared && typeof SharedArrayBuffer === "function" ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  writeGridHeader(buffer, shape);
  return attachFrameGrid(buffer as SharedArrayBuffer);
}

/** Attach a grid over a buffer received from another thread or tab (either buffer kind). */
export function attachGrid(buffer: ArrayBufferLike): FrameGrid {
  return attachFrameGrid(buffer as SharedArrayBuffer);
}

/** A copy of a grid's bytes in a plain ArrayBuffer, the only kind a BroadcastChannel will clone. */
export function copyGridBytes(grid: FrameGrid): ArrayBuffer {
  return new Uint8Array(grid.buffer).slice().buffer;
}

/**
 * Copy every frame of `evf` that lands on the window into `grid`. Frames off the grid (a different step, or
 * outside the window) are skipped. Returns the indices written; the caller bumps the grid once per batch.
 */
export function fillGrid(grid: FrameGrid, w: FrameWindow, evf: ParsedEvf, bytes: Uint8Array): number[] {
  const want = gridShapeFor(evf.header, grid.shape.frameCount);
  if (!sameGridShape(grid.shape, want)) {
    throw new Error(`EVF grid ${evf.header.hsCols}x${evf.header.hsRows}/${evf.header.envCols}x${evf.header.envRows} does not match the resident grid`);
  }
  const written: number[] = [];
  for (const f of evf.frames) {
    const index = frameIndexExact(w, f.atMs);
    if (index < 0) continue;
    writeFrameFromEvf(grid, index, bytes, f.offset);
    written.push(index);
  }
  return written;
}

/** Bytes of one frame as stored in `cache_frames`: the full EVF2 frame body, sightings included. */
export function frameBody(bytes: Uint8Array, f: EvfFrame): Uint8Array {
  return bytes.subarray(f.offset, f.offset + f.byteLength);
}

/** Header for a single-frame EVF2 body, so a cached frame round-trips through `parseEvf`. */
export function singleFrameEvf(h: EvfHeader, atMs: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(EVF_HEADER_BYTES + body.byteLength);
  const view = new DataView(out.buffer);
  out.set([0x45, 0x56, 0x46, 0x32], 0); // "EVF2"
  view.setUint32(4, 1, true);
  view.setUint32(8, h.hsCols, true);
  view.setUint32(12, h.hsRows, true);
  view.setFloat64(16, h.west, true);
  view.setFloat64(24, h.south, true);
  view.setFloat64(32, h.hsCellDeg, true);
  view.setBigInt64(40, BigInt(atMs), true);
  view.setUint32(48, h.stepMinutes, true);
  view.setUint32(52, h.speciesCount, true);
  view.setUint16(56, h.envCols, true);
  view.setUint16(58, h.envRows, true);
  view.setFloat32(60, h.envCellDeg, true);
  view.setFloat32(64, h.hotspotScale, true);
  view.setUint32(68, 0, true);
  out.set(body, EVF_HEADER_BYTES);
  return out;
}

/** Sightings of one frame, decoded from its body (C4 record layout). */
export type Sighting = { lon: number; lat: number; taxon: number; quality: number; flags: number };

export function readSightings(h: EvfHeader, body: Uint8Array): Sighting[] {
  const layout = evfFrameLayout(h);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(layout.sightingsOffset, true);
  const out: Sighting[] = [];
  let p = layout.sightingsOffset + 4;
  for (let i = 0; i < count; i++, p += 12) {
    out.push({
      lon: view.getFloat32(p, true),
      lat: view.getFloat32(p + 4, true),
      taxon: view.getUint16(p + 8, true),
      quality: view.getUint8(p + 10),
      flags: view.getUint8(p + 11),
    });
  }
  return out;
}
