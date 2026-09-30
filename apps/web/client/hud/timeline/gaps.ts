/**
 * Timeline gaps (PRD §3 flow 3, §7 "Missing"): stretches where data is missing are hatched and never
 * interpolated.
 *
 * There is no feed-state history in the API (only the current envelope), so gaps come from the frames
 * already in memory, which costs no request:
 *
 * 1. **Structural cells are ignored.** SST is always missing over land and LST over open water. A cell
 *    counts toward coverage only if it is valid in at least one loaded frame of the window.
 * 2. **`ENV_MISSING`**: every counted LST and SST cell is `ENV_MISSING` (the i16 sentinel, PLAN.md C4).
 *    GOES delivered nothing usable for that frame: a feed outage, or the whole region under cloud.
 * 3. **`CLOUD`**: at least `CLOUD_FRACTION` of the counted cells are missing, but not all. Cloud or DQF
 *    masking over a large part of the region.
 * 4. **`NO_SIGHTINGS`**: the frame sits in a run of zero-sighting frames lasting at least `QUIET_RUN_MS`.
 *    One empty 15-minute frame is normal; half a day with no report from any biological feed is not.
 *    Only computed when per-frame sighting counts are known.
 * 5. **`UNLOADED`**: every LST and SST value is exactly 0. The grid is allocated zeroed and 0.00 °C does
 *    not occur in South Florida, so this is a frame the db worker has not filled yet. Drawn as pending,
 *    not as a gap, and left out of steps 1–4.
 */
import { ENV_MISSING } from "shared/frames";

export const GAP_FLAG = { ENV_MISSING: 1, CLOUD: 2, NO_SIGHTINGS: 4, UNLOADED: 8 } as const;
export const CLOUD_FRACTION = 0.5;
export const QUIET_RUN_MS = 12 * 60 * 60_000;

export type GapKind = "env" | "cloud" | "quiet" | "unloaded";
export type GapSegment = { kind: GapKind; start: number; end: number };

/** The slice of a FrameGrid this module reads. */
export type EnvFrames = {
  shape: { frameCount: number };
  lst(frame: number): Int16Array;
  sst(frame: number): Int16Array;
};

function isUnloaded(lst: Int16Array, sst: Int16Array): boolean {
  for (let i = 0; i < lst.length; i++) if (lst[i] !== 0 || sst[i] !== 0) return false;
  return true;
}

/**
 * Per-frame flag bits. `sightingCounts[i]` is frame i's sighting count, or null when unknown.
 * `frameSpacingMs` is the time between grid frames.
 */
export function frameGapFlags(grid: EnvFrames, sightingCounts: ArrayLike<number> | null, frameSpacingMs: number): Uint8Array {
  const n = grid.shape.frameCount;
  const flags = new Uint8Array(n);
  if (n === 0) return flags;

  // Pass 1: which cells are ever valid (bit 1 LST, bit 2 SST), skipping unloaded frames.
  let ever: Uint8Array | null = null;
  for (let f = 0; f < n; f++) {
    const lst = grid.lst(f);
    const sst = grid.sst(f);
    if (isUnloaded(lst, sst)) {
      flags[f] = GAP_FLAG.UNLOADED;
      continue;
    }
    ever ??= new Uint8Array(lst.length);
    for (let i = 0; i < lst.length; i++) {
      if (lst[i] !== ENV_MISSING) ever[i] |= 1;
      if (sst[i] !== ENV_MISSING) ever[i] |= 2;
    }
  }

  // Pass 2: missing share of the counted cells.
  if (ever) {
    let counted = 0;
    for (let i = 0; i < ever.length; i++) counted += (ever[i] & 1) + ((ever[i] >> 1) & 1);
    for (let f = 0; f < n; f++) {
      if (flags[f] & GAP_FLAG.UNLOADED) continue;
      if (counted === 0) {
        flags[f] |= GAP_FLAG.ENV_MISSING;
        continue;
      }
      const lst = grid.lst(f);
      const sst = grid.sst(f);
      let missing = 0;
      for (let i = 0; i < ever.length; i++) {
        const e = ever[i];
        if (e & 1 && lst[i] === ENV_MISSING) missing++;
        if (e & 2 && sst[i] === ENV_MISSING) missing++;
      }
      if (missing === counted) flags[f] |= GAP_FLAG.ENV_MISSING;
      else if (missing / counted >= CLOUD_FRACTION) flags[f] |= GAP_FLAG.CLOUD;
    }
  }

  // Pass 3: long runs without sightings.
  if (sightingCounts && sightingCounts.length >= n && frameSpacingMs > 0) {
    const minRun = Math.max(1, Math.ceil(QUIET_RUN_MS / frameSpacingMs));
    let runStart = -1;
    for (let f = 0; f <= n; f++) {
      const quiet = f < n && !(flags[f] & GAP_FLAG.UNLOADED) && sightingCounts[f] === 0;
      if (quiet && runStart < 0) runStart = f;
      if (!quiet && runStart >= 0) {
        if (f - runStart >= minRun) for (let g = runStart; g < f; g++) flags[g] |= GAP_FLAG.NO_SIGHTINGS;
        runStart = -1;
      }
    }
  }
  return flags;
}

/** Runs of frames with `bit` set, as half-open `[start, end)` frame ranges. */
export function segmentFlags(flags: ArrayLike<number>, bit: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && (flags[i] & bit) !== 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  }
  return out;
}

const KIND_BITS: [GapKind, number][] = [
  ["env", GAP_FLAG.ENV_MISSING],
  ["cloud", GAP_FLAG.CLOUD],
  ["quiet", GAP_FLAG.NO_SIGHTINGS],
  ["unloaded", GAP_FLAG.UNLOADED],
];

/** Every gap run, per kind. Kinds may overlap in time (a cloudy frame can also be quiet). */
export function gapSegments(flags: ArrayLike<number>): GapSegment[] {
  return KIND_BITS.flatMap(([kind, bit]) => segmentFlags(flags, bit).map((s) => ({ kind, ...s })));
}
