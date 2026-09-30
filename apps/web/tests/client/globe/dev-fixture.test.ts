import { describe, expect, test } from "bun:test";

import { DEV_SAMPLE_URL, loadDevFrames, onMainland, syntheticFrames } from "client/globe/dev-fixture";
import { frameIndexAt } from "client/globe/frame-index";
import { ENV_MISSING } from "shared/frames";

const STEP = 15 * 60_000;
const TO = Date.parse("2026-09-30T20:00:00Z");

describe("dev fixture", () => {
  test("mainland mask: Everglades and Miami are land, the Gulf, Florida Bay and the Straits are not", () => {
    expect(onMainland(-80.9, 25.7)).toBe(true);
    expect(onMainland(-80.3, 25.8)).toBe(true);
    expect(onMainland(-82.5, 25.5)).toBe(false);
    expect(onMainland(-80.7, 24.95)).toBe(false);
    expect(onMainland(-80.5, 24.4)).toBe(false);
  });

  test("synthetic frames are C4-shaped, end on the live edge and are populated", () => {
    const { grid, timeline } = syntheticFrames({ toMs: TO, stepMs: STEP, frameCount: 24 });
    expect(grid.shape).toMatchObject({ frameCount: 24, hsCols: 170, hsRows: 160, speciesCount: 4, envCols: 68, envRows: 64 });
    expect(timeline.frame0Ms + 23 * STEP).toBe(TO);
    expect(frameIndexAt(TO, timeline.frame0Ms, timeline.stepMs, 24)).toBe(23);
    for (let s = 0; s < 4; s += 1) expect(Math.max(...grid.hotspot(0, s))).toBeGreaterThan(100);
    const lst = grid.lst(0);
    const sst = grid.sst(0);
    const lstValid = lst.filter((v) => v !== ENV_MISSING).length;
    const sstValid = sst.filter((v) => v !== ENV_MISSING).length;
    expect(lstValid).toBeGreaterThan(200);
    expect(sstValid).toBeGreaterThan(1500);
    // Land and sea are exclusive per cell.
    for (let i = 0; i < lst.length; i += 1) expect(lst[i] !== ENV_MISSING && sst[i] !== ENV_MISSING).toBe(false);
    const total = Array.from({ length: 24 }, (_, f) => timeline.sightings(f).length).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10);
    expect(timeline.sightings(99)).toEqual([]);
  });

  test("deterministic for a seed", () => {
    const a = syntheticFrames({ toMs: TO, stepMs: STEP, frameCount: 4, seed: 5 });
    const b = syntheticFrames({ toMs: TO, stepMs: STEP, frameCount: 4, seed: 5 });
    expect(a.timeline.sightings(2)).toEqual(b.timeline.sightings(2));
    expect([...a.grid.sst(3)]).toEqual([...b.grid.sst(3)]);
  });

  test("the golden sample.evf (a small EVF2 patch) loads only when forced, placed by its header geometry", async () => {
    const bytes = new Uint8Array(await Bun.file(new URL("../../../../../spec/frames/sample.evf", import.meta.url)).arrayBuffer());
    const fetchImpl = (async () => new Response(bytes)) as unknown as typeof fetch;
    const auto = await loadDevFrames({ toMs: TO, stepMs: STEP, fetchImpl });
    expect(auto.source).toBe("synthetic");
    expect(auto.note).toMatch(/patch/);
    const forced = await loadDevFrames({ toMs: TO, stepMs: STEP, fetchImpl, force: true });
    expect(forced.source).toBe("sample");
    const { geometry, frameCount, stepMs, frame0Ms } = forced.timeline;
    expect(geometry).toMatchObject({ west: -80.5, south: 25.2, hsCellDeg: 0.02 });
    expect(frame0Ms + (frameCount - 1) * stepMs).toBe(TO);
    expect(forced.grid.shape.frameCount).toBe(frameCount);
  });

  test("loadDevFrames falls back to synthetic when the sample is not EVF2 or not served", async () => {
    let asked = "";
    const evf1 = new Uint8Array(72);
    evf1.set([69, 86, 70, 49]); // "EVF1"
    const fetchImpl = (async (url: string) => {
      asked = url;
      return new Response(evf1);
    }) as unknown as typeof fetch;
    const fromEvf1 = await loadDevFrames({ toMs: TO, stepMs: STEP, fetchImpl });
    expect(asked).toBe(DEV_SAMPLE_URL);
    expect(fromEvf1.source).toBe("synthetic");
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect((await loadDevFrames({ toMs: TO, stepMs: STEP, fetchImpl: notFound })).source).toBe("synthetic");
  });
});
