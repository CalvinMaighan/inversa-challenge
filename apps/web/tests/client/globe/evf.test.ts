import { describe, expect, test } from "bun:test";

import { evfSightings, gridFromEvf, indexEvf } from "client/globe/evf";
import { ENV_MISSING, EVF_HEADER_BYTES, evfFrameBytes, evfFrameLayout, type EvfHeader } from "shared/frames";

const header: EvfHeader = {
  frameCount: 2,
  hsCols: 3,
  hsRows: 2,
  west: -83.2,
  south: 24.3,
  hsCellDeg: 0.02,
  frame0UnixMs: Date.parse("2026-09-01T00:00:00Z"),
  stepMinutes: 60,
  speciesCount: 2,
  envCols: 2,
  envRows: 1,
  envCellDeg: 0.05,
  hotspotScale: 0.5,
};

type Frame = { hotspot: number[]; lst: number[]; sst: number[]; sightings: [number, number, number, number, number][] };

/** Minimal EVF2 writer for the test (the real one is api/src/frames.rs). */
function encode(h: EvfHeader, frames: Frame[]): Uint8Array {
  const size = EVF_HEADER_BYTES + frames.reduce((n, f) => n + evfFrameBytes(h, f.sightings.length), 0);
  const bytes = new Uint8Array(size);
  const v = new DataView(bytes.buffer);
  "EVF2".split("").forEach((ch, i) => v.setUint8(i, ch.charCodeAt(0)));
  v.setUint32(4, h.frameCount, true);
  v.setUint32(8, h.hsCols, true);
  v.setUint32(12, h.hsRows, true);
  v.setFloat64(16, h.west, true);
  v.setFloat64(24, h.south, true);
  v.setFloat64(32, h.hsCellDeg, true);
  v.setBigInt64(40, BigInt(h.frame0UnixMs), true);
  v.setUint32(48, h.stepMinutes, true);
  v.setUint32(52, h.speciesCount, true);
  v.setUint16(56, h.envCols, true);
  v.setUint16(58, h.envRows, true);
  v.setFloat32(60, h.envCellDeg, true);
  v.setFloat32(64, h.hotspotScale, true);
  const layout = evfFrameLayout(h);
  let at = EVF_HEADER_BYTES;
  for (const f of frames) {
    bytes.set(f.hotspot, at);
    f.lst.forEach((c, i) => v.setInt16(at + layout.lstOffset + i * 2, c, true));
    f.sst.forEach((c, i) => v.setInt16(at + layout.sstOffset + i * 2, c, true));
    v.setUint32(at + layout.sightingsOffset, f.sightings.length, true);
    f.sightings.forEach(([lon, lat, taxon, quality, flags], k) => {
      const r = at + layout.sightingsOffset + 4 + k * 12;
      v.setFloat32(r, lon, true);
      v.setFloat32(r + 4, lat, true);
      v.setUint16(r + 8, taxon, true);
      v.setUint8(r + 10, quality);
      v.setUint8(r + 11, flags);
    });
    at += evfFrameBytes(h, f.sightings.length);
  }
  return bytes;
}

const frames: Frame[] = [
  { hotspot: [1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 50, 60], lst: [2150, ENV_MISSING], sst: [ENV_MISSING, 2710], sightings: [[-80.5, 25.25, 3, 0, 2], [-81, 25, 9, 2, 1]] },
  { hotspot: new Array(12).fill(7), lst: [-100, 0], sst: [1, 2], sightings: [] },
];

describe("EVF2 walker", () => {
  const bytes = encode(header, frames);

  test("indexes frames with variable sighting sections", () => {
    const index = indexEvf(bytes);
    expect(index.header.frameCount).toBe(2);
    expect(index.sightingCounts).toEqual([2, 0]);
    expect(index.frameOffsets[0]).toBe(EVF_HEADER_BYTES);
    expect(index.frameOffsets[1]).toBe(EVF_HEADER_BYTES + evfFrameBytes(header, 2));
  });

  test("decodes sighting records", () => {
    const index = indexEvf(bytes);
    const [a, b] = evfSightings(bytes, index, 0);
    expect(a).toMatchObject({ taxon: 3, quality: 0, flags: 2 });
    expect(a!.lon).toBeCloseTo(-80.5, 5);
    expect(a!.lat).toBeCloseTo(25.25, 5);
    expect(b).toMatchObject({ taxon: 9, quality: 2, flags: 1 });
    expect(evfSightings(bytes, index, 1)).toEqual([]);
  });

  test("gridFromEvf copies hotspot and env sections into the SAB grid byte for byte", () => {
    const { grid, sightings } = gridFromEvf(bytes);
    expect(grid.shape).toMatchObject({ frameCount: 2, hsCols: 3, hsRows: 2, speciesCount: 2, envCols: 2, envRows: 1 });
    expect(grid.hotspotScale).toBeCloseTo(0.5);
    expect([...grid.hotspot(0, 1)]).toEqual([10, 20, 30, 40, 50, 60]);
    expect([...grid.lst(0)]).toEqual([2150, ENV_MISSING]);
    expect([...grid.sst(0)]).toEqual([ENV_MISSING, 2710]);
    expect([...grid.lst(1)]).toEqual([-100, 0]);
    expect(grid.version()).toBe(1);
    expect(sightings.map((s) => s.length)).toEqual([2, 0]);
  });

  test("rejects a wrong magic and a truncated body", () => {
    const evf1 = bytes.slice();
    evf1[3] = "1".charCodeAt(0);
    expect(() => indexEvf(evf1)).toThrow(/bad magic/);
    expect(() => indexEvf(bytes.subarray(0, bytes.length - 5))).toThrow(RangeError);
    expect(() => indexEvf(new Uint8Array(10))).toThrow(RangeError);
  });
});
