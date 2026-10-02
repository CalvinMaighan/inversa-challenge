import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { gridFromEvf, indexEvf } from "client/globe/evf";
import { frameBody, parseEvf, readSightings, sightingBytes, singleFrameEvf } from "client/threads/db/frames";
import { getApp } from "shared/apps";
import {
  ENV_MISSING,
  EVF_HEADER_BYTES,
  EVF_REGION_DESC_BYTES,
  evfHeaderLength,
  evfRegionFrame,
  evfRegions,
  evfSpecies,
  readEvfHeader,
  walkEvf,
  type EvfHeader,
} from "shared/frames";

/** Golden vectors written by api/src/frames.rs (spec/frames/README.md). */
const SPEC = path.join(import.meta.dir, "../../../../spec/frames");
const load = (name: string) => new Uint8Array(readFileSync(path.join(SPEC, name)));
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function decode(bytes: Uint8Array) {
  const view = viewOf(bytes);
  const header = readEvfHeader(view);
  const frames = walkEvf(view, header);
  const region = (f: number, r: number) => evfRegionFrame(bytes, header, frames[f]!, r);
  return { header, frames, region };
}

const at = (bytes: Uint8Array, h: EvfHeader, region: number, col: number, row: number) => {
  const r = evfRegions(h)[region]!;
  return bytes[row * r.hsCols + col];
};

describe("frames regions", () => {
  test("two-regions.evf decodes per spec/frames/README.md", () => {
    const bytes = load("two-regions.evf");
    const { header: h, frames, region } = decode(bytes);
    expect([h.frameCount, h.stepMinutes, h.speciesCount, h.regionCount]).toEqual([3, 60, 1, 2]);
    expect(new Date(h.frame0UnixMs).toISOString()).toBe("2025-02-01T00:00:00.000Z");
    expect(evfHeaderLength(h)).toBe(EVF_HEADER_BYTES + 2 * EVF_REGION_DESC_BYTES);
    const [r0, r1] = evfRegions(h);
    expect(r0).toMatchObject({ hsCols: 10, hsRows: 5, envCols: 4, envRows: 2, west: -80.5, south: 25.2 });
    expect(r1).toMatchObject({ hsCols: 15, hsRows: 10, envCols: 6, envRows: 4, west: -80.2, south: 25.2 });
    for (const r of [r0!, r1!]) {
      expect(r.hsCellDeg).toBeCloseTo(0.02, 12);
      expect(r.envCellDeg).toBe(0.05);
    }
    // Region 0's grid fields are the header's.
    expect([h.hsCols, h.hsRows, h.envCols, h.envRows, h.west, h.south]).toEqual([10, 5, 4, 2, -80.5, 25.2]);

    // Every byte is accounted for: frame k starts after every region body of frames < k.
    expect(frames[0]!.offset).toBe(evfHeaderLength(h));
    const last = frames.at(-1)!;
    expect(last.offset + last.byteLength).toBe(bytes.byteLength);
    expect(frames.map((f) => f.regions.map((b) => b.sightingCount))).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);

    for (let f = 0; f < 3; f++) {
      const west = region(f, 0);
      const east = region(f, 1);
      // Scoring cell (2,2) / (10,10) is hotspot cell (1,1) / (5,5).
      expect(at(west.hotspot, h, 0, 1, 1)).toBe(100);
      expect(at(east.hotspot, h, 1, 5, 5)).toBe(10);
      expect(east.sst[0]).toBe(2400);
      expect([...west.sst].every((v) => v === ENV_MISSING)).toBe(true);
    }
    const rec = region(2, 1).sightings[0]!;
    expect([rec.id, rec.quality, rec.flags]).toEqual([4, 2, 2]);
  });

  test("two-regions.evf through the globe walker and the db worker", () => {
    const bytes = load("two-regions.evf");
    const index = indexEvf(bytes);
    expect([...index.sightingCounts]).toEqual([0, 1, 1]);
    const { grid, meta, sightings } = gridFromEvf(bytes);
    // The grid holds region 0.
    expect([grid.shape.hsCols, grid.shape.hsRows, grid.shape.speciesCount]).toEqual([10, 5, 1]);
    expect(meta.geometry).toMatchObject({ west: -80.5, south: 25.2 });
    for (let f = 0; f < 3; f++) expect(grid.hotspot(f, 0)[1 * 10 + 1]).toBe(100);
    expect(sightings.records(2).map((r) => r.id)).toEqual([4]);

    const evf = parseEvf(bytes);
    expect(evf.frames.map((f) => f.sightingCount)).toEqual([0, 1, 1]);
    const f2 = evf.frames[2]!;
    expect(readSightings(evf.header, frameBody(bytes, f2)).map((r) => r.id)).toEqual([4]);
    expect(sightingBytes(evf.header, frameBody(bytes, f2)).byteLength).toBe(16);
    // A cached frame keeps its region table.
    const one = parseEvf(singleFrameEvf(evf.header, f2.atMs, frameBody(bytes, f2)));
    expect([one.header.regionCount, one.frames.length, one.frames[0]!.sightingCount]).toEqual([2, 1, 1]);
    expect(evfRegions(one.header)).toEqual(evfRegions(evf.header));
  });

  test("sample.evf still decodes as one region", () => {
    const bytes = load("sample.evf");
    const { header: h, frames } = decode(bytes);
    expect([h.regionCount, h.speciesCount, h.frameCount]).toEqual([1, 1, 3]);
    expect(evfHeaderLength(h)).toBe(EVF_HEADER_BYTES);
    expect(evfRegions(h)).toEqual([{ hsCols: 10, hsRows: 5, west: -80.5, south: 25.2, hsCellDeg: h.hsCellDeg, envCols: 4, envRows: 2, envCellDeg: 0.05 }]);
    expect(frames.map((f) => f.sightingCount)).toEqual([1, 1, 3]);
    const last = frames.at(-1)!;
    expect(last.offset + last.byteLength).toBe(bytes.byteLength);
    expect([...indexEvf(bytes).sightingCounts]).toEqual([1, 1, 3]);
  });

  test("live lionfish frames from the fixture backfill", () => {
    const app = getApp("lionfish");
    const bytes = load("lionfish.evf");
    const { header: h, frames, region } = decode(bytes);
    expect(h.regionCount).toBe(app.regions.length);
    expect(h.regionCount).toBe(4);
    expect(h.speciesCount).toBe(evfSpecies(app).length);
    expect(h.speciesCount).toBe(1);
    expect(evfHeaderLength(h)).toBe(EVF_HEADER_BYTES + 4 * EVF_REGION_DESC_BYTES);
    evfRegions(h).forEach((r, i) => {
      const cfg = app.regions[i]!;
      const cols = Math.round((cfg.bbox.east - cfg.bbox.west) / cfg.cellDeg);
      const rows = Math.round((cfg.bbox.north - cfg.bbox.south) / cfg.cellDeg);
      expect([r.west, r.south]).toEqual([cfg.bbox.west, cfg.bbox.south]);
      expect(r.hsCellDeg).toBeCloseTo(2 * cfg.cellDeg, 12);
      expect(r.envCellDeg).toBeCloseTo(5 * cfg.cellDeg, 6);
      expect([r.hsCols, r.hsRows, r.envCols, r.envRows]).toEqual([cols / 2, rows / 2, cols / 5, rows / 5]);
    });
    expect(frames).toHaveLength(2);
    const last = frames.at(-1)!;
    expect(last.offset + last.byteLength).toBe(bytes.byteLength);
    // Fixture iNat record + its GBIF copy in Florida, synthetic rows off Cozumel and Cartagena (api/src/frames.rs).
    expect(frames.map((f) => f.regions.map((b) => b.sightingCount))).toEqual([
      [2, 1, 0, 0],
      [0, 0, 0, 1],
    ]);
    for (let f = 0; f < frames.length; f++) {
      for (let r = 0; r < 4; r++) {
        const { bbox } = app.regions[r]!;
        for (const s of region(f, r).sightings) {
          expect(s.lon >= bbox.west && s.lon < bbox.east && s.lat >= bbox.south && s.lat < bbox.north).toBe(true);
          expect(s.taxon).toBeGreaterThanOrEqual(1);
        }
      }
    }
    // The db worker reads every region's records; the grid keeps region 0.
    expect(parseEvf(bytes).frames.map((f) => f.sightingCount)).toEqual([3, 1]);
    const { grid, sightings } = gridFromEvf(bytes);
    expect([grid.shape.hsCols, grid.shape.hsRows]).toEqual([evfRegions(h)[0]!.hsCols, evfRegions(h)[0]!.hsRows]);
    expect(sightings.records(1)).toEqual(region(1, 3).sightings);
  });
});
