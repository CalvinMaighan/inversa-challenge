import { describe, expect, test } from "bun:test";
import { allocFrameGrid, writeFrameFromEvf } from "@calvinjs/active-state/threads";

import { ENV_MISSING } from "shared/frames";

import { buildFixtureEvf, FIXTURE_FRAMES, FIXTURE_SCRIPT, FIXTURE_STEP_MINUTES } from "client/hud/dev/fixture";
import { evfFrames, evfSightingCounts } from "client/hud/timeline/frame-stats";
import { frameIndexAt, frameTimeMs, stepAt, timeAtStep, windowSteps } from "client/hud/timeline/frames";
import { CLOUD_FRACTION, frameGapFlags, GAP_FLAG, gapSegments, QUIET_RUN_MS, segmentFlags, type EnvFrames } from "client/hud/timeline/gaps";

const STEP = FIXTURE_STEP_MINUTES * 60_000;

/** A tiny env-only grid: `frames[f]` gives [lst, sst] for each of its cells. */
function envGrid(frames: [number, number][][]): EnvFrames {
  return {
    shape: { frameCount: frames.length },
    lst: (f) => Int16Array.from(frames[f]!.map(([l]) => l)),
    sst: (f) => Int16Array.from(frames[f]!.map(([, s]) => s)),
  };
}

const M = ENV_MISSING;

describe("gap segmentation", () => {
  test("segmentFlags returns half-open runs of a bit, including runs at both ends", () => {
    const flags = Uint8Array.from([1, 1, 0, 3, 2, 1, 0, 0, 1]);
    expect(segmentFlags(flags, 1)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
      { start: 8, end: 9 },
    ]);
    expect(segmentFlags(flags, 2)).toEqual([{ start: 3, end: 5 }]);
    expect(segmentFlags(new Uint8Array(0), 1)).toEqual([]);
  });

  test("gapSegments splits flags into per-kind runs that may overlap", () => {
    const { ENV_MISSING: E, CLOUD: C, NO_SIGHTINGS: Q, UNLOADED: U } = GAP_FLAG;
    const flags = Uint8Array.from([U, U, 0, C, C | Q, Q, E | Q, E, 0]);
    expect(gapSegments(flags)).toEqual([
      { kind: "env", start: 6, end: 8 },
      { kind: "cloud", start: 3, end: 5 },
      { kind: "quiet", start: 4, end: 7 },
      { kind: "unloaded", start: 0, end: 2 },
    ]);
  });

  test("structural cells (never valid) do not count: land SST and sea LST are always missing", () => {
    // Cell 0 is land (LST only), cell 1 is water (SST only).
    const grid = envGrid([
      [
        [2500, M],
        [M, 2800],
      ],
      [
        [2600, M],
        [M, 2810],
      ],
    ]);
    expect(Array.from(frameGapFlags(grid, null, STEP))).toEqual([0, 0]);
  });

  test("all counted cells missing is ENV_MISSING; at least half is CLOUD; less is nothing", () => {
    const land = (v: number): [number, number] => [v, M];
    const grid = envGrid([
      [land(2500), land(2500), land(2500), land(2500)],
      [land(M), land(M), land(M), land(M)],
      [land(M), land(M), land(2500), land(2500)],
      [land(M), land(2500), land(2500), land(2500)],
    ]);
    expect(Array.from(frameGapFlags(grid, null, STEP))).toEqual([0, GAP_FLAG.ENV_MISSING, GAP_FLAG.CLOUD, 0]);
    expect(CLOUD_FRACTION).toBe(0.5);
  });

  test("all-zero frames are UNLOADED (never filled), not gaps, and do not vote on coverage", () => {
    const grid = envGrid([
      [
        [0, 0],
        [0, 0],
      ],
      [
        [2500, M],
        [M, 2800],
      ],
    ]);
    expect(Array.from(frameGapFlags(grid, Uint32Array.from([0, 0]), STEP))).toEqual([GAP_FLAG.UNLOADED, 0]);
  });

  test("zero-sighting runs are gaps only once they last QUIET_RUN_MS", () => {
    const n = 60;
    const ok: [number, number][] = [[2500, M]];
    const grid = envGrid(Array.from({ length: n }, () => ok));
    const runFrames = QUIET_RUN_MS / STEP; // 48 at 15 min
    const counts = new Uint32Array(n).fill(3);
    counts.fill(0, 5, 5 + runFrames - 1); // one frame short: not a gap
    let flags = frameGapFlags(grid, counts, STEP);
    expect(segmentFlags(flags, GAP_FLAG.NO_SIGHTINGS)).toEqual([]);
    counts.fill(0, 5, 5 + runFrames); // exactly the threshold
    flags = frameGapFlags(grid, counts, STEP);
    expect(segmentFlags(flags, GAP_FLAG.NO_SIGHTINGS)).toEqual([{ start: 5, end: 5 + runFrames }]);
    // Unknown counts: no quiet flags at all.
    expect(segmentFlags(frameGapFlags(grid, null, STEP), GAP_FLAG.NO_SIGHTINGS)).toEqual([]);
  });

  test("gap segmentation from flags of the fixture grid finds exactly the scripted cloud deck, outage and silence", () => {
    const from = Date.parse("2026-09-29T20:45:00Z");
    const fixture = buildFixtureEvf(from);
    const { header, offsets, counts } = evfFrames(fixture.bytes);
    expect(header.frameCount).toBe(FIXTURE_FRAMES);
    expect(evfSightingCounts(fixture.bytes)).toEqual(counts);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(fixture.records.length);
    const grid = allocFrameGrid({ ...header });
    for (let f = 0; f < header.frameCount; f++) writeFrameFromEvf(grid, f, fixture.bytes, offsets[f]!);

    const segs = gapSegments(frameGapFlags(grid, counts, STEP));
    const [qs, qe] = FIXTURE_SCRIPT.quiet;
    const [cs, ce] = FIXTURE_SCRIPT.cloud;
    const [os, oe] = FIXTURE_SCRIPT.outage;
    expect(segs).toEqual([
      { kind: "env", start: os, end: oe },
      { kind: "cloud", start: cs, end: ce },
      { kind: "quiet", start: qs, end: qe },
    ]);
  });

  test("evfFrames rejects a truncated buffer instead of reading garbage counts", () => {
    const fixture = buildFixtureEvf(Date.parse("2026-09-29T20:45:00Z"), 3);
    expect(() => evfFrames(fixture.bytes.subarray(0, fixture.bytes.length - 5))).toThrow(RangeError);
  });
});

describe("frame index mapping", () => {
  const from = Date.parse("2026-09-01T00:00:00Z");
  const to = from + 95 * STEP;

  test("scrubber steps and grid frames coincide when the grid has one frame per step", () => {
    expect(windowSteps(from, to)).toBe(95);
    for (let s = 0; s <= 95; s++) {
      const at = timeAtStep(s, from);
      expect(stepAt(at, from, to)).toBe(s);
      expect(frameIndexAt(at, from, to, 96)).toBe(s);
      expect(frameTimeMs(s, from, to, 96)).toBe(at);
    }
  });

  test("coarser grids share frames across steps; out-of-window instants clamp; no grid is -1", () => {
    const hourlyTo = from + 24 * 4 * STEP; // 24 h window, 25 hourly frames
    expect(frameIndexAt(from + 4 * STEP, from, hourlyTo, 25)).toBe(1);
    expect(frameIndexAt(from + 5 * STEP, from, hourlyTo, 25)).toBe(1);
    expect(frameIndexAt(from - 10 * STEP, from, to, 96)).toBe(0);
    expect(frameIndexAt(to + 10 * STEP, from, to, 96)).toBe(95);
    expect(stepAt(to + STEP, from, to)).toBe(95);
    expect(frameIndexAt(from, from, to, 0)).toBe(-1);
    expect(frameIndexAt(to, from, to, 1)).toBe(0);
  });
});
