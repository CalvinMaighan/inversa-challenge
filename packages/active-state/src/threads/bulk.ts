/**
 * Quantized frame grids over a SharedArrayBuffer (EVF2-shaped, PLAN C4).
 *
 * Each frame's fixed part mirrors the EVF2 frame body byte for byte, so a
 * decoded frame is copied in with one `set`:
 *   hotspot u8[speciesCount * hsCols * hsRows]   species-major, row-major from SW
 *   pad to 2
 *   lst i16[envCols * envRows]                    centi-degC, ENV_MISSING = no reading, -32767 = flagged
 *   sst i16[envCols * envRows]
 *   pad to 4
 * A writer (the db worker) calls `writeFrameFromEvf` then `bump()`; readers
 * (Cesium layers on main) take `hotspot / lst / sst` views with no copy and
 * watch `version()`. `frameCount` is the resident window, not the archive.
 * The library takes the shape as parameters and never reads an EVF header.
 */
import { waitChange } from "./ring";

export type GridShape = {
  frameCount: number;
  hsCols: number;
  hsRows: number;
  speciesCount: number;
  envCols: number;
  envRows: number;
  /** score = u8 * hotspotScale. */
  hotspotScale: number;
};

/** i16 sentinel for an environment cell with no reading (-32767, one above, marks a flagged pixel; see apps/web/shared/frames.ts). */
export const ENV_MISSING = -32768;

/** "EVF2" as a little-endian u32. */
export const GRID_MAGIC = 0x32465645;
const HDR_MAGIC = 0;
const HDR_VERSION = 1;
const HDR_FRAMES = 2;
const HDR_HS_COLS = 3;
const HDR_HS_ROWS = 4;
const HDR_SPECIES = 5;
const HDR_ENV_COLS = 6;
const HDR_ENV_ROWS = 7;
const HDR_SCALE = 8; // f32
const HDR_LENGTH = 12;
export const GRID_HEADER_BYTES = HDR_LENGTH * 4;

export type FrameLayout = {
  hotspotBytes: number;
  hsCells: number;
  envCells: number;
  lstOffset: number;
  sstOffset: number;
  /** Bytes of one frame's fixed part, padded to 4. */
  frameBytes: number;
};

export type FrameGrid = {
  readonly buffer: SharedArrayBuffer;
  readonly shape: GridShape;
  readonly layout: FrameLayout;
  readonly hotspotScale: number;
  /** One frame's fixed part, byte-identical to the EVF2 frame body up to the sightings. */
  frame(index: number): Uint8Array;
  hotspot(frame: number, species: number): Uint8Array;
  lst(frame: number): Int16Array;
  sst(frame: number): Int16Array;
  version(): number;
  /** Publish a change: increments the version and wakes waiters. Returns the new version. */
  bump(): number;
  /** Resolves with the current version once it differs from `seen`. */
  waitVersion(seen: number, timeoutMs?: number): Promise<number>;
};

const align = (n: number, to: number): number => Math.ceil(n / to) * to;

function assertShape(shape: GridShape): void {
  for (const name of [
    "frameCount",
    "hsCols",
    "hsRows",
    "speciesCount",
    "envCols",
    "envRows",
  ] as const) {
    const n = shape[name];
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `[active-state/threads] grid ${name} must be a non-negative integer, got ${n}`,
      );
    }
  }
  if (!Number.isFinite(shape.hotspotScale)) {
    throw new Error(
      `[active-state/threads] grid hotspotScale must be finite, got ${shape.hotspotScale}`,
    );
  }
}

export function frameLayout(shape: GridShape): FrameLayout {
  assertShape(shape);
  const hsCells = shape.hsCols * shape.hsRows;
  const hotspotBytes = shape.speciesCount * hsCells;
  const envCells = shape.envCols * shape.envRows;
  const lstOffset = align(hotspotBytes, 2);
  const sstOffset = lstOffset + envCells * 2;
  const frameBytes = align(sstOffset + envCells * 2, 4);
  return { hotspotBytes, hsCells, envCells, lstOffset, sstOffset, frameBytes };
}

export function frameGridBytes(shape: GridShape): number {
  return GRID_HEADER_BYTES + shape.frameCount * frameLayout(shape).frameBytes;
}

/** Allocate a zeroed grid buffer for `shape` and return views over it. */
export function allocFrameGrid(shape: GridShape): FrameGrid {
  const buffer = new SharedArrayBuffer(frameGridBytes(shape));
  const hdr = new Int32Array(buffer, 0, HDR_LENGTH);
  hdr[HDR_MAGIC] = GRID_MAGIC;
  hdr[HDR_FRAMES] = shape.frameCount;
  hdr[HDR_HS_COLS] = shape.hsCols;
  hdr[HDR_HS_ROWS] = shape.hsRows;
  hdr[HDR_SPECIES] = shape.speciesCount;
  hdr[HDR_ENV_COLS] = shape.envCols;
  hdr[HDR_ENV_ROWS] = shape.envRows;
  new Float32Array(buffer, HDR_SCALE * 4, 1)[0] = shape.hotspotScale;
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
    hsCols: hdr[HDR_HS_COLS]!,
    hsRows: hdr[HDR_HS_ROWS]!,
    speciesCount: hdr[HDR_SPECIES]!,
    envCols: hdr[HDR_ENV_COLS]!,
    envRows: hdr[HDR_ENV_ROWS]!,
    hotspotScale: new Float32Array(buffer, HDR_SCALE * 4, 1)[0]!,
  };
  const layout = frameLayout(shape);
  const expected = frameGridBytes(shape);
  if (buffer.byteLength !== expected) {
    throw new Error(
      `[active-state/threads] grid buffer is ${buffer.byteLength} bytes, header implies ${expected}`,
    );
  }

  const check = (name: string, n: number, limit: number): void => {
    if (!Number.isInteger(n) || n < 0 || n >= limit) {
      throw new RangeError(
        `[active-state/threads] ${name} ${n} out of range [0, ${limit})`,
      );
    }
  };
  const frameStart = (frame: number): number => {
    check("frame", frame, shape.frameCount);
    return GRID_HEADER_BYTES + frame * layout.frameBytes;
  };

  return {
    buffer,
    shape,
    layout,
    hotspotScale: shape.hotspotScale,
    frame(index) {
      return new Uint8Array(buffer, frameStart(index), layout.frameBytes);
    },
    hotspot(frame, species) {
      check("species", species, shape.speciesCount);
      return new Uint8Array(
        buffer,
        frameStart(frame) + species * layout.hsCells,
        layout.hsCells,
      );
    },
    lst(frame) {
      return new Int16Array(
        buffer,
        frameStart(frame) + layout.lstOffset,
        layout.envCells,
      );
    },
    sst(frame) {
      return new Int16Array(
        buffer,
        frameStart(frame) + layout.sstOffset,
        layout.envCells,
      );
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

/**
 * Copy one decoded EVF2 frame body (its fixed part: hotspot, lst, sst) from
 * `evfBytes` at `frameOffset` into frame `index`. Sightings that follow the
 * fixed part are left in `evfBytes`. Call `grid.bump()` after a batch.
 */
export function writeFrameFromEvf(
  grid: FrameGrid,
  index: number,
  evfBytes: Uint8Array,
  frameOffset: number,
): void {
  const n = grid.layout.frameBytes;
  if (!Number.isInteger(frameOffset) || frameOffset < 0) {
    throw new RangeError(
      `[active-state/threads] frameOffset must be a non-negative integer, got ${frameOffset}`,
    );
  }
  if (frameOffset + n > evfBytes.length) {
    throw new RangeError(
      `[active-state/threads] EVF frame at ${frameOffset} needs ${n} bytes, buffer has ${evfBytes.length - frameOffset}`,
    );
  }
  grid.frame(index).set(evfBytes.subarray(frameOffset, frameOffset + n));
}
