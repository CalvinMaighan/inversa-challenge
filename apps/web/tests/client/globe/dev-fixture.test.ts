import { describe, expect, test } from "bun:test";

import { DEV_SAMPLE_URL, liveEdgeFrame0, loadDevFrames, onMainland, SYNTHETIC_ID_BASE, syntheticFrames } from "client/globe/dev-fixture";
import { frameForTime } from "client/globe/frame-index";
import { ENV_MISSING, type EvfHeader } from "shared/frames";

import { encodeEvf } from "./fakes";

const HOUR = 60 * 60_000;
const TO = Date.parse("2026-09-30T20:45:00Z");

const serve = (bytes: Uint8Array) => (async () => new Response(new Uint8Array(bytes))) as unknown as typeof fetch;

describe("dev fixture", () => {
  test("mainland mask: Everglades and Miami are land, the Gulf, Florida Bay and the Straits are not", () => {
    expect(onMainland(-80.9, 25.7)).toBe(true);
    expect(onMainland(-80.3, 25.8)).toBe(true);
    expect(onMainland(-82.5, 25.5)).toBe(false);
    expect(onMainland(-80.7, 24.95)).toBe(false);
    expect(onMainland(-80.5, 24.4)).toBe(false);
  });

  test("the window ends on the frame containing the live edge", () => {
    expect(liveEdgeFrame0(TO, 60, 1)).toBe(Date.parse("2026-09-30T20:00:00Z"));
    expect(liveEdgeFrame0(TO, 60, 168)).toBe(Date.parse("2026-09-30T20:00:00Z") - 167 * HOUR);
  });

  test("synthetic frames: C4 grid, hourly C16 meta ending on the live edge, sightings with ids", () => {
    const { grid, meta, sightings } = syntheticFrames({ toMs: TO, frameCount: 24 });
    expect(grid.shape).toMatchObject({ frameCount: 24, hsCols: 170, hsRows: 160, speciesCount: 1, envCols: 68, envRows: 64 });
    expect(meta).toMatchObject({ stepMinutes: 60, frameCount: 24, geometry: { west: -83.2, south: 24.3, hsCellDeg: 0.02, envCellDeg: 0.05 } });
    expect(frameForTime(TO, meta)).toBe(23);
    expect(frameForTime(meta.frame0UnixMs - 1, meta)).toBe(-1);
    expect(Math.max(...grid.hotspot(0, 0))).toBeGreaterThan(100);
    const lst = grid.lst(0);
    const sst = grid.sst(0);
    expect(lst.filter((v) => v !== ENV_MISSING).length).toBeGreaterThan(200);
    expect(sst.filter((v) => v !== ENV_MISSING).length).toBeGreaterThan(1500);
    for (let i = 0; i < lst.length; i += 1) expect(lst[i] !== ENV_MISSING && sst[i] !== ENV_MISSING).toBe(false);
    expect(sightings.counts.length).toBe(24);
    const all = Array.from({ length: 24 }, (_, f) => sightings.records(f)).flat();
    expect(all.length).toBe(sightings.counts.reduce((a, b) => a + b, 0));
    expect(all.length).toBeGreaterThan(10);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(Math.min(...all.map((r) => r.id))).toBe(SYNTHETIC_ID_BASE);
  });

  test("deterministic for a seed", () => {
    const a = syntheticFrames({ toMs: TO, frameCount: 4, seed: 5 });
    const b = syntheticFrames({ toMs: TO, frameCount: 4, seed: 5 });
    expect(a.sightings.records(2)).toEqual(b.sightings.records(2));
    expect([...a.grid.sst(3)]).toEqual([...b.grid.sst(3)]);
  });

  test("a sample patch loads only when forced, re-based to the live edge and placed by its header geometry", async () => {
    const h: EvfHeader = {
      frameCount: 3,
      hsCols: 10,
      hsRows: 5,
      west: -80.5,
      south: 25.2,
      hsCellDeg: 0.02,
      frame0UnixMs: Date.parse("2025-02-01T00:00:00Z"),
      stepMinutes: 60,
      speciesCount: 1,
      envCols: 4,
      envRows: 2,
      envCellDeg: 0.05,
      hotspotScale: 0.01,
    };
    const empty = { hotspot: new Array(50).fill(0), lst: new Array(8).fill(0), sst: new Array(8).fill(0) };
    const bytes = encodeEvf(h, [
      { ...empty, sightings: [[42, -80.45, 25.25, 1, 0, 0]] },
      { ...empty, sightings: [] },
      { ...empty, sightings: [] },
    ]);
    const auto = await loadDevFrames({ toMs: TO, fetchImpl: serve(bytes) });
    expect(auto.source).toBe("synthetic");
    expect(auto.note).toMatch(/patch/);
    const forced = await loadDevFrames({ toMs: TO, fetchImpl: serve(bytes), force: true });
    expect(forced.source).toBe("sample");
    expect(forced.meta.geometry).toEqual({ west: -80.5, south: 25.2, hsCellDeg: 0.02, envCellDeg: 0.05 });
    expect(frameForTime(TO, forced.meta)).toBe(2);
    expect(forced.sightings.records(0)[0]!.id).toBe(42);
  });

  test("the golden spec/frames/sample.evf decodes: header geometry, 16-byte records with sighting ids", async () => {
    const bytes = new Uint8Array(await Bun.file(new URL("../../../../../spec/frames/sample.evf", import.meta.url)).arrayBuffer());
    const forced = await loadDevFrames({ toMs: TO, fetchImpl: serve(bytes), force: true });
    expect(forced.source).toBe("sample");
    expect(forced.meta).toMatchObject({ stepMinutes: 60, frameCount: 3, geometry: { west: -80.5, south: 25.2, hsCellDeg: 0.02, envCellDeg: 0.05 } });
    const records = Array.from({ length: 3 }, (_, f) => forced.sightings.records(f)).flat();
    expect(records.length).toBe(forced.sightings.counts.reduce((a, b) => a + b, 0));
    for (const r of records) {
      expect(Number.isInteger(r.id) && r.id > 0).toBe(true);
      expect(r.lon).toBeGreaterThan(-80.5);
      expect(r.lat).toBeGreaterThan(25.2);
    }
  });

  test("falls back to synthetic when the sample is not EVF2 or not served", async () => {
    let asked = "";
    const evf1 = new Uint8Array(72);
    evf1.set([69, 86, 70, 49]); // "EVF1"
    const fetchImpl = (async (url: string) => {
      asked = url;
      return new Response(evf1);
    }) as unknown as typeof fetch;
    const fromEvf1 = await loadDevFrames({ toMs: TO, fetchImpl });
    expect(asked).toBe(DEV_SAMPLE_URL);
    expect(fromEvf1.source).toBe("synthetic");
    expect(fromEvf1.meta.frameCount).toBe(168);
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect((await loadDevFrames({ toMs: TO, fetchImpl: notFound })).source).toBe("synthetic");
  });
});
