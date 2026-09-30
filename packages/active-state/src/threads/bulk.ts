/**
 * Float32 frame grids over a SharedArrayBuffer.
 *
 * Layout matches the EVF1 per-frame fixed part (PLAN C4): for each frame,
 * `hotspot` f32 × speciesCount × cells (species-major), then `lst` f32 ×
 * cells, then `sst` f32 × cells. A writer (the db worker) fills
 * `grid.frame(i)` and calls `bump()`; readers (Cesium layers on main) take
 * `hotspot / lst / sst` views with no copy and watch `version()`.
 *
 * `frameCount` is the resident window, not the whole archive: at 340 × 320
 * cells and four species one frame is about 2.6 MB.
 */
import { waitChange } from "./ring";

export type GridShape = {
  frameCount: number;
  cols: number;
  rows: number;
  speciesCount: number;
};

/** "EVF1" as a little-endian u32. */
export const GRID_MAGIC = 0x31465645;
const HDR_MAGIC = 0;
const HDR_VERSION = 1;
const HDR_FRAMES = 2;
const HDR_COLS = 3;
const HDR_ROWS = 4;
const HDR_SPECIES = 5;
const HDR_LENGTH = 8;
export const GRID_HEADER_BYTES = HDR_LENGTH * 4;

export type FrameGrid = {
  readonly buffer: SharedArrayBuffer;
  readonly shape: GridShape;
  readonly cells: number;
  /** Floats per frame: (speciesCount + 2) × cells. */
  readonly frameFloats: number;
  /** Every frame, contiguous. */
  readonly floats: Float32Array;
  /** One frame's fixed part; matches the EVF1 frame layout so a decoded frame can be `set` directly. */
  frame(index: number): Float32Array;
  hotspot(frame: number, species: number): Float32Array;
  lst(frame: number): Float32Array;
  sst(frame: number): Float32Array;
  version(): number;
  /** Publish a change: increments the version and wakes waiters. Returns the new version. */
  bump(): number;
  /** Resolves with the current version once it differs from `seen`. */
  waitVersion(seen: number, timeoutMs?: number): Promise<number>;
};

function assertShape(shape: GridShape): void {
  for (const [name, n] of Object.entries(shape)) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `[active-state/threads] grid ${name} must be a non-negative integer, got ${n}`,
      );
    }
  }
}

export function frameGridBytes(shape: GridShape): number {
  assertShape(shape);
  const cells = shape.cols * shape.rows;
  return (
    GRID_HEADER_BYTES +
    shape.frameCount * (shape.speciesCount + 2) * cells * 4
  );
}

/** Allocate a zeroed grid buffer for `shape` and return views over it. */
export function allocFrameGrid(shape: GridShape): FrameGrid {
  const buffer = new SharedArrayBuffer(frameGridBytes(shape));
  const hdr = new Int32Array(buffer, 0, HDR_LENGTH);
  hdr[HDR_MAGIC] = GRID_MAGIC;
  hdr[HDR_FRAMES] = shape.frameCount;
  hdr[HDR_COLS] = shape.cols;
  hdr[HDR_ROWS] = shape.rows;
  hdr[HDR_SPECIES] = shape.speciesCount;
  return attachFrameGrid(buffer);
}

/** Views over a grid buffer allocated elsewhere (another thread). */
export function attachFrameGrid(buffer: SharedArrayBuffer): FrameGrid {
  if (buffer.byteLength < GRID_HEADER_BYTES) {
    throw new Error("[active-state/threads] grid buffer too small for a header");
  }
  const hdr = new Int32Array(buffer, 0, HDR_LENGTH);
  if (hdr[HDR_MAGIC] !== GRID_MAGIC) {
    throw new Error("[active-state/threads] grid buffer has a bad magic");
  }
  const shape: GridShape = {
    frameCount: hdr[HDR_FRAMES]!,
    cols: hdr[HDR_COLS]!,
    rows: hdr[HDR_ROWS]!,
    speciesCount: hdr[HDR_SPECIES]!,
  };
  const expected = frameGridBytes(shape);
  if (buffer.byteLength !== expected) {
    throw new Error(
      `[active-state/threads] grid buffer is ${buffer.byteLength} bytes, header implies ${expected}`,
    );
  }
  const cells = shape.cols * shape.rows;
  const frameFloats = (shape.speciesCount + 2) * cells;
  const floats = new Float32Array(
    buffer,
    GRID_HEADER_BYTES,
    shape.frameCount * frameFloats,
  );

  const check = (name: string, n: number, limit: number): void => {
    if (!Number.isInteger(n) || n < 0 || n >= limit) {
      throw new RangeError(
        `[active-state/threads] ${name} ${n} out of range [0, ${limit})`,
      );
    }
  };
  const frameStart = (frame: number): number => {
    check("frame", frame, shape.frameCount);
    return frame * frameFloats;
  };

  return {
    buffer,
    shape,
    cells,
    frameFloats,
    floats,
    frame(index) {
      const start = frameStart(index);
      return floats.subarray(start, start + frameFloats);
    },
    hotspot(frame, species) {
      check("species", species, shape.speciesCount);
      const start = frameStart(frame) + species * cells;
      return floats.subarray(start, start + cells);
    },
    lst(frame) {
      const start = frameStart(frame) + shape.speciesCount * cells;
      return floats.subarray(start, start + cells);
    },
    sst(frame) {
      const start = frameStart(frame) + (shape.speciesCount + 1) * cells;
      return floats.subarray(start, start + cells);
    },
    version() {
      return Atomics.load(hdr, HDR_VERSION);
    },
    bump() {
      const next = Atomics.add(hdr, HDR_VERSION, 1) + 1;
      Atomics.notify(hdr, HDR_VERSION);
      return next;
    },
    waitVersion(seen, timeoutMs) {
      return waitChange(hdr, HDR_VERSION, seen, timeoutMs).then(() =>
        Atomics.load(hdr, HDR_VERSION),
      );
    },
  };
}
