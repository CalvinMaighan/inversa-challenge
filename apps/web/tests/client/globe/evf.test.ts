import { describe, expect, test } from "bun:test";

import { evfSightings, frameSightingsOf, gridFromEvf, indexEvf, metaFromHeader } from "client/globe/evf";
import { ENV_MISSING, EVF_HEADER_BYTES, evfFrameBytes, SIGHTING_RECORD_BYTES, type EvfHeader } from "shared/frames";

import { encodeEvf, type EvfTestFrame } from "./fakes";

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

const frames: EvfTestFrame[] = [
  {
    hotspot: [1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 50, 60],
    lst: [2150, ENV_MISSING],
    sst: [ENV_MISSING, 2710],
    sightings: [
      [4_000_123, -80.5, 25.25, 3, 0, 2],
      [17, -81, 25, 9, 2, 1],
    ],
  },
  { hotspot: new Array(12).fill(7), lst: [-100, 0], sst: [1, 2], sightings: [] },
];

describe("EVF2 walker", () => {
  const bytes = encodeEvf(header, frames);

  test("16-byte records", () => {
    expect(SIGHTING_RECORD_BYTES).toBe(16);
  });

  test("indexes frames with variable sighting sections", () => {
    const index = indexEvf(bytes);
    expect(index.header.frameCount).toBe(2);
    expect([...index.sightingCounts]).toEqual([2, 0]);
    expect(index.frameOffsets[0]).toBe(EVF_HEADER_BYTES);
    expect(index.frameOffsets[1]).toBe(EVF_HEADER_BYTES + evfFrameBytes(header, 2));
  });

  test("decodes sighting records with their ids", () => {
    const index = indexEvf(bytes);
    const [a, b] = evfSightings(bytes, index, 0);
    expect(a).toMatchObject({ id: 4_000_123, taxon: 3, quality: 0, flags: 2 });
    expect(a!.lon).toBeCloseTo(-80.5, 5);
    expect(a!.lat).toBeCloseTo(25.25, 5);
    expect(b).toMatchObject({ id: 17, taxon: 9, quality: 2, flags: 1 });
    expect(evfSightings(bytes, index, 1)).toEqual([]);
  });

  test("gridFromEvf: SAB grid byte for byte, C16 meta with geometry, decoded FrameSightings", () => {
    const { grid, meta, sightings } = gridFromEvf(bytes);
    expect(grid.shape).toMatchObject({ frameCount: 2, hsCols: 3, hsRows: 2, speciesCount: 2, envCols: 2, envRows: 1 });
    expect(grid.hotspotScale).toBeCloseTo(0.5);
    expect([...grid.hotspot(0, 1)]).toEqual([10, 20, 30, 40, 50, 60]);
    expect([...grid.lst(0)]).toEqual([2150, ENV_MISSING]);
    expect([...grid.sst(0)]).toEqual([ENV_MISSING, 2710]);
    expect([...grid.lst(1)]).toEqual([-100, 0]);
    expect(grid.version()).toBe(1);
    expect(meta).toEqual({
      frame0UnixMs: header.frame0UnixMs,
      stepMinutes: 60,
      frameCount: 2,
      geometry: { west: -83.2, south: 24.3, hsCellDeg: 0.02, envCellDeg: 0.05 },
    });
    expect([...sightings.counts]).toEqual([2, 0]);
    expect(sightings.records(0).map((r) => r.id)).toEqual([4_000_123, 17]);
    expect(sightings.records(0)).toBe(sightings.records(0)); // decoded once
    expect(sightings.records(5)).toEqual([]);
    expect(metaFromHeader(header).geometry.envCellDeg).toBe(0.05);
  });

  test("frameSightingsOf wraps per-frame lists", () => {
    const s = frameSightingsOf([[{ id: 1, lon: 0, lat: 0, taxon: 1, quality: 0, flags: 0 }], []]);
    expect([...s.counts]).toEqual([1, 0]);
    expect(s.records(0)[0]!.id).toBe(1);
    expect(s.records(9)).toEqual([]);
  });

  test("rejects a wrong magic and a truncated body", () => {
    const evf1 = bytes.slice();
    evf1[3] = "1".charCodeAt(0);
    expect(() => indexEvf(evf1)).toThrow(/bad magic/);
    expect(() => indexEvf(bytes.subarray(0, bytes.length - 5))).toThrow(RangeError);
    expect(() => indexEvf(new Uint8Array(10))).toThrow(RangeError);
  });
});
