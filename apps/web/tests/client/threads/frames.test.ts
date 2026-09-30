import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { allocFrameGrid, ENV_MISSING, GRID_HEADER_BYTES } from "@calvinjs/active-state/threads";

import {
  allocGrid,
  attachGrid,
  chunksWithin,
  chunkUrl,
  copyGridBytes,
  fillGrid,
  FINE_SPAN_MS,
  frameAtIndex,
  frameBody,
  frameIndexAt,
  frameIndexExact,
  frameWindow,
  gridShapeFor,
  MAX_CHUNK_FRAMES,
  missingChunks,
  parseEvf,
  readSightings,
  singleFrameEvf,
} from "client/threads/db/frames";
import { EVF_MAGIC } from "shared/frames";

import { encodeEvf2, hotspotValue, lstValue, sstValue } from "./evf-fixture";

const H = 3_600_000;
const Q = 900_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

describe("frameWindow", () => {
  test("30 days at 15-minute alignment: hourly to 24 h before the end, then quarter-hours", () => {
    const to = T0 + 30 * 24 * H;
    const w = frameWindow(new Date(T0).toISOString(), new Date(to).toISOString());
    expect(w.coarseStartMs).toBe(T0);
    expect(w.splitMs).toBe(to - FINE_SPAN_MS);
    expect(w.coarseCount).toBe(29 * 24);
    expect(w.fineCount).toBe(97);
    expect(w.frameCount).toBe(29 * 24 + 97);
    expect(frameAtIndex(w, 0)).toBe(T0);
    expect(frameAtIndex(w, w.coarseCount - 1)).toBe(w.splitMs - H);
    expect(frameAtIndex(w, w.coarseCount)).toBe(w.splitMs);
    expect(frameAtIndex(w, w.frameCount - 1)).toBe(to);
    expect(() => frameAtIndex(w, w.frameCount)).toThrow(RangeError);
  });

  test("an unaligned start rounds the first hourly frame up", () => {
    const w = frameWindow(T0 + 20 * 60_000, T0 + 30 * 24 * H);
    expect(w.coarseStartMs).toBe(T0 + H);
    expect(w.coarseCount).toBe(29 * 24 - 1);
  });

  test("a window of a day or less is all fine steps", () => {
    const w = frameWindow(T0, T0 + 6 * H);
    expect(w.coarseCount).toBe(0);
    expect(w.fineCount).toBe(25);
    expect(frameIndexAt(w, T0 - 1)).toBe(0);
    expect(frameIndexAt(w, T0 + 6 * H + 1)).toBe(24);
  });

  test("frameIndexAt maps a cursor to the frame at or before it, clamped", () => {
    const to = T0 + 30 * 24 * H;
    const w = frameWindow(T0, to);
    expect(frameIndexAt(w, T0 - 5 * H)).toBe(0);
    expect(frameIndexAt(w, T0 + 90 * 60_000)).toBe(1);
    expect(frameIndexAt(w, w.splitMs - 1)).toBe(w.coarseCount - 1);
    expect(frameIndexAt(w, w.splitMs)).toBe(w.coarseCount);
    expect(frameIndexAt(w, w.splitMs + Q + 1)).toBe(w.coarseCount + 1);
    expect(frameIndexAt(w, to + 10 * H)).toBe(w.frameCount - 1);
  });

  test("frameIndexExact rejects off-grid timestamps", () => {
    const w = frameWindow(T0, T0 + 30 * 24 * H);
    expect(frameIndexExact(w, T0 + H)).toBe(1);
    expect(frameIndexExact(w, T0 + Q)).toBe(-1);
    expect(frameIndexExact(w, w.splitMs + Q)).toBe(w.coarseCount + 1);
    expect(frameIndexExact(w, w.toMs + Q)).toBe(-1);
    expect(frameIndexExact(w, T0 - H)).toBe(-1);
  });

  test("bad bounds throw", () => {
    expect(() => frameWindow("nope", T0)).toThrow();
    expect(() => frameWindow(T0, T0 - 1)).toThrow();
  });
});

describe("chunks", () => {
  const w = frameWindow(T0, T0 + 30 * 24 * H);

  test("an empty cache asks for one hourly run and one fine run", () => {
    const chunks = missingChunks(w, new Set());
    expect(chunks).toEqual([
      { fromMs: T0, toMs: w.splitMs - H, stepMinutes: 60 },
      { fromMs: w.splitMs, toMs: w.toMs, stepMinutes: 15 },
    ]);
    expect(chunkUrl("/v1/frames", chunks[1]!)).toBe(`/v1/frames?from=${encodeURIComponent(new Date(w.splitMs).toISOString())}&to=${encodeURIComponent(new Date(w.toMs).toISOString())}&step=15`);
  });

  test("present frames split runs; a fully cached window asks for nothing", () => {
    const present = new Set<number>();
    for (let i = 0; i < w.frameCount; i++) present.add(frameAtIndex(w, i));
    expect(missingChunks(w, present)).toEqual([]);
    present.delete(T0 + 5 * H);
    present.delete(T0 + 6 * H);
    present.delete(w.splitMs + 3 * Q);
    expect(missingChunks(w, present)).toEqual([
      { fromMs: T0 + 5 * H, toMs: T0 + 6 * H, stepMinutes: 60 },
      { fromMs: w.splitMs + 3 * Q, toMs: w.splitMs + 3 * Q, stepMinutes: 15 },
    ]);
  });

  test("a run never exceeds the REST cap", () => {
    const wide = frameWindow(T0, T0 + 40 * 24 * H);
    const [first, second] = missingChunks(wide, new Set());
    expect((first!.toMs - first!.fromMs) / H + 1).toBe(MAX_CHUNK_FRAMES);
    expect(second!.stepMinutes).toBe(60);
  });

  test("chunksWithin restricts a refetch to a framesUpdated range", () => {
    expect(chunksWithin(w, w.toMs - 2 * Q, w.toMs)).toEqual([{ fromMs: w.toMs - 2 * Q, toMs: w.toMs, stepMinutes: 15 }]);
    expect(chunksWithin(w, T0 + 10 * H + 1, T0 + 12 * H)).toEqual([{ fromMs: T0 + 11 * H, toMs: T0 + 12 * H, stepMinutes: 60 }]);
    expect(chunksWithin(w, T0 - 5 * H, T0 - H)).toEqual([]);
  });
});

describe("EVF2 into a FrameGrid", () => {
  const w = frameWindow(T0, T0 + 2 * 24 * H);
  const fixture = encodeEvf2({ frame0UnixMs: w.splitMs, stepMinutes: 15, frameCount: 5, sightingsPerFrame: 3 });

  test("parseEvf walks variable-length frames", () => {
    const evf = parseEvf(fixture);
    expect(evf.header.frameCount).toBe(5);
    expect(evf.frames.map((f) => f.atMs)).toEqual([0, 1, 2, 3, 4].map((i) => w.splitMs + i * Q));
    expect(evf.frames[1]!.offset).toBe(evf.frames[0]!.offset + evf.frames[0]!.byteLength);
    expect(evf.frames.every((f) => f.sightingCount === 3)).toBe(true);
    expect(() => parseEvf(fixture.subarray(0, fixture.length - 10))).toThrow(/truncated|needs/);
    expect(() => parseEvf(new Uint8Array(10))).toThrow(/shorter/);
  });

  test("fillGrid places frames by timestamp and copies hotspot, lst and sst byte for byte", () => {
    const evf = parseEvf(fixture);
    const grid = allocGrid(gridShapeFor(evf.header, w.frameCount), true);
    const written = fillGrid(grid, w, evf, fixture);
    expect(written).toEqual([0, 1, 2, 3, 4].map((i) => w.coarseCount + i));
    const hs = grid.hotspot(w.coarseCount + 2, 3);
    expect(hs.length).toBe(48);
    for (let c = 0; c < hs.length; c++) expect(hs[c]).toBe(hotspotValue(2, 3, c));
    const lst = grid.lst(w.coarseCount + 4);
    expect(lst.length).toBe(12);
    for (let c = 0; c < lst.length; c++) expect(lst[c]).toBe(lstValue(4, c));
    expect(lst[4]).toBe(ENV_MISSING);
    const sst = grid.sst(w.coarseCount);
    for (let c = 0; c < sst.length; c++) expect(sst[c]).toBe(sstValue(0, c));
    // Untouched frames stay zero.
    expect(grid.hotspot(0, 0).every((v) => v === 0)).toBe(true);
  });

  test("frames off the window's grid are skipped, a shape mismatch throws", () => {
    const evf = parseEvf(fixture);
    const shifted = encodeEvf2({ frame0UnixMs: w.toMs - Q, stepMinutes: 15, frameCount: 3 });
    const grid = allocGrid(gridShapeFor(evf.header, w.frameCount), true);
    expect(fillGrid(grid, w, parseEvf(shifted), shifted)).toEqual([w.frameCount - 2, w.frameCount - 1]);
    const other = encodeEvf2({ frame0UnixMs: w.splitMs, stepMinutes: 15, frameCount: 1, hsCols: 4 });
    expect(() => fillGrid(grid, w, parseEvf(other), other)).toThrow(/does not match/);
  });

  test("a single-frame body round-trips through the cache row format", () => {
    const evf = parseEvf(fixture);
    const f = evf.frames[3]!;
    const row = singleFrameEvf(evf.header, f.atMs, frameBody(fixture, f));
    const again = parseEvf(row);
    expect(again.header).toEqual({ ...evf.header, frameCount: 1, frame0UnixMs: f.atMs });
    expect(again.frames[0]!.atMs).toBe(f.atMs);
    const grid = allocGrid(gridShapeFor(evf.header, w.frameCount), true);
    expect(fillGrid(grid, w, again, row)).toEqual([w.coarseCount + 3]);
    expect(grid.hotspot(w.coarseCount + 3, 1)[5]).toBe(hotspotValue(3, 1, 5));
    const sightings = readSightings(again.header, frameBody(row, again.frames[0]!));
    expect(sightings).toHaveLength(3);
    expect(sightings[1]).toEqual({ lon: expect.closeTo(-80.4, 5), lat: expect.closeTo(25.23, 5), taxon: 2, quality: 1, flags: 4 });
  });

  test("allocGrid writes the same header as allocFrameGrid, shared or not", () => {
    const shape = gridShapeFor(parseEvf(fixture).header, 7);
    const reference = allocFrameGrid(shape);
    const shared = allocGrid(shape, true);
    const plain = allocGrid(shape, false);
    expect(shared.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(plain.buffer).toBeInstanceOf(ArrayBuffer);
    const head = (g: { buffer: ArrayBufferLike }) => Array.from(new Uint8Array(g.buffer, 0, GRID_HEADER_BYTES));
    expect(head(shared)).toEqual(head(reference));
    expect(head(plain)).toEqual(head(reference));
    expect(plain.shape).toEqual(reference.shape);
    expect(plain.bump()).toBe(1);
    expect(plain.version()).toBe(1);
  });

  test("a grid snapshot is a plain copy that attaches on another tab", () => {
    const evf = parseEvf(fixture);
    const grid = allocGrid(gridShapeFor(evf.header, w.frameCount), true);
    fillGrid(grid, w, evf, fixture);
    grid.bump();
    const copy = copyGridBytes(grid);
    expect(copy).toBeInstanceOf(ArrayBuffer);
    expect(copy.byteLength).toBe(grid.buffer.byteLength);
    const twin = attachGrid(copy);
    expect(twin.version()).toBe(1);
    expect(Array.from(twin.hotspot(w.coarseCount + 1, 2))).toEqual(Array.from(grid.hotspot(w.coarseCount + 1, 2)));
  });
});

describe("golden file", () => {
  const path = resolve(import.meta.dir, "../../../../../spec/frames/sample.evf");
  const bytes = new Uint8Array(readFileSync(path));
  const magic = String.fromCharCode(...bytes.subarray(0, 4));

  test(magic === EVF_MAGIC ? "spec/frames/sample.evf fills a grid" : "spec/frames/sample.evf is not EVF2 yet (T11 rework pending); parseEvf rejects it", () => {
    if (magic !== EVF_MAGIC) {
      expect(() => parseEvf(bytes)).toThrow(/bad magic/);
      return;
    }
    const evf = parseEvf(bytes);
    const stepMs = evf.header.stepMinutes * 60_000;
    const last = evf.header.frame0UnixMs + (evf.header.frameCount - 1) * stepMs;
    const w = frameWindow(evf.header.frame0UnixMs, last);
    const grid = allocGrid(gridShapeFor(evf.header, w.frameCount), true);
    const written = fillGrid(grid, w, evf, bytes);
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThanOrEqual(evf.header.frameCount);
    for (const i of written) {
      const frame = grid.frame(i);
      expect(frame.length).toBe(grid.layout.frameBytes);
    }
  });
});
