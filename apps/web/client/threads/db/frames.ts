/**
 * Frame axis and EVF2 -> FrameGrid mapping for the db worker (PLAN.md C4, C16). Pure.
 *
 * One hourly grid spans the TIME window: frame `i` is at `frame0UnixMs + i * 60 min`. The axis is the
 * time part of `FrameMeta`; the geometry part comes from the first EVF2 header seen (`frameMetaFor`).
 * Everyone maps time to frames with `frameIndexAt` from `client/threads/api.ts`.
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

import type { FrameMeta } from "client/threads/api";
import {
  EVF_HEADER_BYTES,
  evfFrameSightingBytes,
  evfHeaderLength,
  readEvfFrameSightings,
  readEvfHeader,
  walkEvf,
  walkEvfFrame,
  writeEvfHeader,
  type EvfFrameRegions,
  type EvfHeader,
  type SightingRecord,
} from "shared/frames";

export const STEP_MINUTES = 60;
const STEP_MS = STEP_MINUTES * 60_000;

/** The time part of `FrameMeta`. */
export type FrameAxis = { frame0UnixMs: number; stepMinutes: number; frameCount: number };

const toMs = (t: string | number): number => (typeof t === "number" ? t : Date.parse(t));

/** Hourly frames from the first hour boundary at or after `from` through the last at or before `to`. */
export function frameAxis(from: string | number, to: string | number): FrameAxis {
  const fromMs = toMs(from);
  const endMs = toMs(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(endMs)) throw new Error(`frameAxis: bad bounds ${String(from)}..${String(to)}`);
  if (endMs < fromMs) throw new Error("frameAxis: to before from");
  const frame0UnixMs = Math.ceil(fromMs / STEP_MS) * STEP_MS;
  const frameCount = Math.max(0, Math.floor((endMs - frame0UnixMs) / STEP_MS) + 1);
  return { frame0UnixMs, stepMinutes: STEP_MINUTES, frameCount };
}

export function sameAxis(a: FrameAxis, b: FrameAxis): boolean {
  return a.frame0UnixMs === b.frame0UnixMs && a.stepMinutes === b.stepMinutes && a.frameCount === b.frameCount;
}

export function frameAtIndex(axis: FrameAxis, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= axis.frameCount) throw new RangeError(`frame index ${index} outside [0, ${axis.frameCount})`);
  return axis.frame0UnixMs + index * axis.stepMinutes * 60_000;
}

/** Index of a frame whose timestamp lands exactly on the axis, else -1. */
export function frameIndexExact(axis: FrameAxis, atMs: number): number {
  const stepMs = axis.stepMinutes * 60_000;
  const rel = atMs - axis.frame0UnixMs;
  if (rel < 0 || rel % stepMs !== 0) return -1;
  const i = rel / stepMs;
  return i < axis.frameCount ? i : -1;
}

/** Last frame time of the axis, or null when empty. */
export function axisEndMs(axis: FrameAxis): number | null {
  return axis.frameCount === 0 ? null : frameAtIndex(axis, axis.frameCount - 1);
}

/** `FrameMeta` for the axis, with the grid placement taken from an EVF2 header. */
export function frameMetaFor(axis: FrameAxis, h: EvfHeader): FrameMeta {
  return { ...axis, geometry: { west: h.west, south: h.south, hsCellDeg: h.hsCellDeg, envCellDeg: h.envCellDeg } };
}

export type ChunkRequest = { fromMs: number; toMs: number; stepMinutes: number };

/** REST caps one response at 744 frames (C4). */
export const MAX_CHUNK_FRAMES = 744;

/**
 * Requests that fill every frame of `axis` not in `present` (a set of frame timestamps), as few contiguous
 * ranges as possible, each within the REST cap.
 */
export function missingChunks(axis: FrameAxis, present: ReadonlySet<number>): ChunkRequest[] {
  const out: ChunkRequest[] = [];
  const stepMs = axis.stepMinutes * 60_000;
  let run: ChunkRequest | null = null;
  for (let i = 0; i < axis.frameCount; i++) {
    const at = frameAtIndex(axis, i);
    if (present.has(at)) {
      if (run) out.push(run);
      run = null;
      continue;
    }
    if (run && run.toMs + stepMs === at && (run.toMs - run.fromMs) / stepMs + 1 < MAX_CHUNK_FRAMES) {
      run.toMs = at;
    } else {
      if (run) out.push(run);
      run = { fromMs: at, toMs: at, stepMinutes: axis.stepMinutes };
    }
  }
  if (run) out.push(run);
  return out;
}

/** Every frame of the axis: what a full refetch asks for. */
export function allChunks(axis: FrameAxis): ChunkRequest[] {
  return missingChunks(axis, new Set());
}

/** Restrict a refetch to the frames of `axis` inside `[fromMs, toMs]` (a `framesUpdated` range). */
export function chunksWithin(axis: FrameAxis, fromMs: number, toMs: number): ChunkRequest[] {
  const present = new Set<number>();
  for (let i = 0; i < axis.frameCount; i++) {
    const at = frameAtIndex(axis, i);
    if (at < fromMs || at > toMs) present.add(at);
  }
  return missingChunks(axis, present);
}

export function chunkUrl(base: string, c: ChunkRequest): string {
  const q = new URLSearchParams({ from: new Date(c.fromMs).toISOString(), to: new Date(c.toMs).toISOString(), step: String(c.stepMinutes) });
  return `${base}?${q.toString()}`;
}

// ---- EVF2 ----------------------------------------------------------------------------------

/**
 * One frame of a parsed chunk. `offset`/`byteLength` span every region body (region 0 first, so the grid's
 * region starts at `offset`); `sightingCount` is every region's; `regions` are the bodies (C-A4).
 */
export type EvfFrame = EvfFrameRegions & { atMs: number };

export type ParsedEvf = { header: EvfHeader; frames: EvfFrame[] };

/** Walk an EVF2 body; throws on a truncated frame. */
export function parseEvf(bytes: Uint8Array): ParsedEvf {
  if (bytes.byteLength < EVF_HEADER_BYTES) throw new Error(`EVF: ${bytes.byteLength} bytes is shorter than the header`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readEvfHeader(view);
  const stepMs = header.stepMinutes * 60_000;
  const frames = walkEvf(view, header).map((f, i): EvfFrame => ({ ...f, atMs: header.frame0UnixMs + i * stepMs }));
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
 * Copy every frame of `evf` that lands on the axis into `grid`. Frames off the axis (a different step, or
 * outside the window) are skipped. Returns `[index, frame]` pairs written; the caller bumps the grid once.
 */
export function fillGrid(grid: FrameGrid, axis: FrameAxis, evf: ParsedEvf, bytes: Uint8Array): [number, EvfFrame][] {
  const want = gridShapeFor(evf.header, grid.shape.frameCount);
  if (!sameGridShape(grid.shape, want)) {
    throw new Error(`EVF grid ${evf.header.hsCols}x${evf.header.hsRows}/${evf.header.envCols}x${evf.header.envRows} does not match the resident grid`);
  }
  const written: [number, EvfFrame][] = [];
  for (const f of evf.frames) {
    const index = frameIndexExact(axis, f.atMs);
    if (index < 0) continue;
    writeFrameFromEvf(grid, index, bytes, f.offset);
    written.push([index, f]);
  }
  return written;
}

/** Bytes of one frame as stored in `cache_frames`: the full EVF2 frame body, sightings included. */
export function frameBody(bytes: Uint8Array, f: EvfFrame): Uint8Array {
  return bytes.subarray(f.offset, f.offset + f.byteLength);
}

const walkBody = (h: EvfHeader, body: Uint8Array) => walkEvfFrame(new DataView(body.buffer, body.byteOffset, body.byteLength), h, 0);

/** The raw sighting records of a frame body (every region's, after each u32 count), for `sightings.ts`. */
export function sightingBytes(h: EvfHeader, body: Uint8Array): Uint8Array {
  return evfFrameSightingBytes(body, h, walkBody(h, body));
}

/** Decoded sightings of one frame body, every region's (C4 record layout via shared/frames.ts). */
export function readSightings(h: EvfHeader, body: Uint8Array): SightingRecord[] {
  return readEvfFrameSightings(new DataView(body.buffer, body.byteOffset, body.byteLength), h, walkBody(h, body));
}

/** Header (with the region table) for a single-frame EVF2 body, so a cached frame round-trips through `parseEvf`. */
export function singleFrameEvf(h: EvfHeader, atMs: number, body: Uint8Array): Uint8Array {
  const headerBytes = evfHeaderLength(h);
  const out = new Uint8Array(headerBytes + body.byteLength);
  writeEvfHeader(new DataView(out.buffer), { ...h, frameCount: 1, frame0UnixMs: atMs });
  out.set(body, headerBytes);
  return out;
}
