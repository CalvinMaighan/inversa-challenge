import { describe, expect, test } from "bun:test";
import {
  allocFrameGrid,
  attachFrameGrid,
  ENV_MISSING,
  frameGridBytes,
  frameLayout,
  GRID_HEADER_BYTES,
  writeFrameFromEvf,
} from "../../src/threads";

// hotspot 4 species * 8 cells = 32 bytes, lst/sst 6 cells * 2 bytes each.
const shape = {
  frameCount: 3,
  hsCols: 4,
  hsRows: 2,
  speciesCount: 4,
  envCols: 3,
  envRows: 2,
  hotspotScale: 0.5,
};

/** The C4 production shape: 0.02 deg hotspot grid, 0.05 deg environment grid. */
const evf2 = {
  frameCount: 24,
  hsCols: 170,
  hsRows: 160,
  speciesCount: 4,
  envCols: 68,
  envRows: 64,
  hotspotScale: 1 / 255,
};

/** Build a fake EVF2 file: 72-byte header, then frame bodies with sightings. */
function fakeEvf(frames: number, sightingsPerFrame: number) {
  const layout = frameLayout(shape);
  const header = 72;
  const bodyBytes = layout.frameBytes + 4 + sightingsPerFrame * 12;
  const bytes = new Uint8Array(header + frames * bodyBytes);
  const view = new DataView(bytes.buffer);
  const offsets: number[] = [];
  for (let f = 0; f < frames; f++) {
    const at = header + f * bodyBytes;
    offsets.push(at);
    for (let i = 0; i < layout.hotspotBytes; i++) bytes[at + i] = f * 40 + i;
    for (let c = 0; c < layout.envCells; c++) {
      view.setInt16(at + layout.lstOffset + c * 2, 2500 + f * 100 + c, true);
      view.setInt16(at + layout.sstOffset + c * 2, c === 0 ? ENV_MISSING : 2800 - c, true);
    }
    view.setUint32(at + layout.frameBytes, sightingsPerFrame, true);
  }
  return { bytes, offsets, layout };
}

describe("frame grid", () => {
  test("layout mirrors the EVF2 frame body and pads to 2 then 4", () => {
    const layout = frameLayout(shape);
    expect(layout).toEqual({
      hotspotBytes: 32,
      hsCells: 8,
      envCells: 6,
      lstOffset: 32,
      sstOffset: 44,
      frameBytes: 56,
    });
    // Odd hotspot byte count pads before the i16 sections.
    const odd = frameLayout({ ...shape, speciesCount: 1, hsCols: 3, hsRows: 1 });
    expect(odd.lstOffset).toBe(4);
    expect(odd.frameBytes).toBe(28);
    expect(frameGridBytes(shape)).toBe(GRID_HEADER_BYTES + 3 * 56);
    expect(() => frameGridBytes({ ...shape, envCols: -1 })).toThrow(/envCols/);
    expect(() => frameGridBytes({ ...shape, hotspotScale: NaN })).toThrow(/hotspotScale/);
  });

  test("EVF2 view sizes: 170x160 u8 hotspot, 68x64 i16 lst/sst, 4 species", () => {
    const grid = allocFrameGrid(evf2);
    expect(grid.hotspot(0, 0)).toBeInstanceOf(Uint8Array);
    expect(grid.hotspot(0, 3).length).toBe(170 * 160);
    expect(grid.lst(23)).toBeInstanceOf(Int16Array);
    expect(grid.lst(23).length).toBe(68 * 64);
    expect(grid.sst(23).length).toBe(68 * 64);
    expect(grid.layout.frameBytes).toBe(4 * 27200 + 2 * 2 * 4352);
    expect(grid.layout.frameBytes % 4).toBe(0);
    expect(grid.buffer.byteLength).toBe(GRID_HEADER_BYTES + 24 * 126208);
    expect(grid.hotspotScale).toBeCloseTo(1 / 255, 9);
    expect(grid.shape.envCols).toBe(68);
    expect(grid.shape.envRows).toBe(64);
    // Each view sits on its own aligned byte offset inside the shared buffer.
    expect(grid.lst(1).byteOffset % 2).toBe(0);
    expect(grid.hotspot(1, 2).buffer).toBe(grid.buffer);
  });

  test("views alias the shared buffer with no copy", () => {
    const grid = allocFrameGrid(shape);
    const other = attachFrameGrid(grid.buffer);
    expect(other.shape).toEqual(shape);
    expect(other.hotspotScale).toBe(0.5);

    grid.hotspot(1, 2).fill(200);
    grid.lst(1)[5] = 2345;
    grid.sst(2)[0] = ENV_MISSING;

    expect(other.hotspot(1, 2)[7]).toBe(200);
    expect(other.hotspot(1, 1)[7]).toBe(0);
    expect(other.hotspot(1, 3)[0]).toBe(0);
    expect(other.lst(1)[5]).toBe(2345);
    expect(other.sst(2)[0]).toBe(ENV_MISSING);
    expect(other.sst(1)[0]).toBe(0);
    expect(other.frame(1)[32 + 10]).toBe(2345 & 0xff);
    expect(other.frame(1)[32 + 11]).toBe(2345 >> 8);
    expect(grid.lst(0).buffer).toBe(grid.buffer);
  });

  test("writeFrameFromEvf copies one frame body and leaves sightings behind", () => {
    const grid = allocFrameGrid(shape);
    const { bytes, offsets, layout } = fakeEvf(3, 2);
    writeFrameFromEvf(grid, 0, bytes, offsets[2]!);
    writeFrameFromEvf(grid, 2, bytes, offsets[0]!);

    expect(grid.hotspot(0, 0)[0]).toBe(80);
    expect(grid.hotspot(0, 3)[7]).toBe(80 + 31);
    expect(grid.lst(0)[0]).toBe(2700);
    expect(grid.lst(0)[5]).toBe(2705);
    expect(grid.sst(0)[0]).toBe(ENV_MISSING);
    expect(grid.sst(0)[5]).toBe(2795);
    expect(grid.hotspot(2, 0)[0]).toBe(0);
    expect(grid.lst(2)[0]).toBe(2500);
    expect(grid.frame(1).every((b) => b === 0)).toBe(true);
    expect(Array.from(grid.frame(0))).toEqual(
      Array.from(bytes.subarray(offsets[2]!, offsets[2]! + layout.frameBytes)),
    );

    expect(() => writeFrameFromEvf(grid, 1, bytes, bytes.length - 10)).toThrow(
      /needs 56 bytes, buffer has 10/,
    );
    expect(() => writeFrameFromEvf(grid, 3, bytes, 72)).toThrow(RangeError);
    expect(() => writeFrameFromEvf(grid, 0, bytes, -1)).toThrow(RangeError);
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
