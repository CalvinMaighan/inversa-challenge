import { describe, expect, test } from "bun:test";
import {
  allocFrameGrid,
  attachFrameGrid,
  frameGridBytes,
  GRID_HEADER_BYTES,
} from "../../src/threads";

const shape = { frameCount: 3, cols: 4, rows: 2, speciesCount: 4 };

describe("frame grid", () => {
  test("sizes match the EVF1 fixed part plus a header", () => {
    expect(frameGridBytes(shape)).toBe(GRID_HEADER_BYTES + 3 * 6 * 8 * 4);
    expect(() => frameGridBytes({ ...shape, cols: -1 })).toThrow(/cols/);
  });

  test("views alias the shared buffer with no copy", () => {
    const grid = allocFrameGrid(shape);
    const other = attachFrameGrid(grid.buffer);
    expect(other.shape).toEqual(shape);
    expect(other.cells).toBe(8);
    expect(other.frameFloats).toBe(48);

    const frame = grid.frame(1);
    expect(frame.length).toBe(48);
    frame.set(Float32Array.from({ length: 48 }, (_, i) => i + 100));

    expect(other.hotspot(1, 0)[0]).toBe(100);
    expect(other.hotspot(1, 3)[7]).toBe(131);
    expect(other.lst(1)[0]).toBe(132);
    expect(other.sst(1)[7]).toBe(147);
    expect(other.lst(0)[0]).toBe(0);
    expect(other.sst(2)[7]).toBe(0);

    other.sst(2)[7] = NaN;
    expect(Number.isNaN(grid.floats[grid.floats.length - 1])).toBe(true);
    expect(grid.hotspot(1, 0).buffer).toBe(grid.buffer);
  });

  test("bounds are checked", () => {
    const grid = allocFrameGrid(shape);
    expect(() => grid.frame(3)).toThrow(RangeError);
    expect(() => grid.hotspot(0, 4)).toThrow(RangeError);
    expect(() => grid.lst(-1)).toThrow(RangeError);
    expect(() => attachFrameGrid(new SharedArrayBuffer(8))).toThrow(/too small/);
    const bad = new SharedArrayBuffer(GRID_HEADER_BYTES);
    expect(() => attachFrameGrid(bad)).toThrow(/magic/);
  });

  test("version bumps notify waiters", async () => {
    const grid = allocFrameGrid(shape);
    const reader = attachFrameGrid(grid.buffer);
    expect(reader.version()).toBe(0);
    const wake = reader.waitVersion(0);
    setTimeout(() => grid.bump(), 5);
    expect(await wake).toBe(1);
    expect(grid.bump()).toBe(2);
    expect(await reader.waitVersion(1)).toBe(2);
    expect(await reader.waitVersion(2, 10)).toBe(2);
  });
});
