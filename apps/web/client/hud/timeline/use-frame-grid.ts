"use client";

import { useEffect, useState } from "react";
import type { FrameGrid } from "@calvinjs/active-state/threads";

import { getFrameGrid, getFrameMeta, getFrameSightings, onFrameGrid, onFrameSightings, type FrameMeta, type FrameSightings } from "client/threads/api";

/** How often the timeline checks the grid version. The timeline summary (gaps, sparkline) is not frame-critical. */
const VERSION_POLL_MS = 500;

type GridState = { grid: FrameGrid | null; meta: FrameMeta | null };

/**
 * The published frame grid, its time axis and its write version. Polls `version()` (one atomic load)
 * instead of `waitVersion`, whose fallback without `Atomics.waitAsync` spins a 1 ms timer on the main thread.
 */
export function useFrameGrid(): GridState & { version: number } {
  const [state, setState] = useState<GridState>(() => ({ grid: getFrameGrid(), meta: getFrameMeta() }));
  const [version, setVersion] = useState(() => getFrameGrid()?.version() ?? 0);

  // publishFrameGrid sets the meta before notifying, so it is current inside the callback.
  useEffect(() => onFrameGrid((grid) => setState({ grid, meta: getFrameMeta() })), []);

  const grid = state.grid;
  useEffect(() => {
    if (!grid) return;
    const tick = () => setVersion(grid.version());
    const id = setInterval(tick, VERSION_POLL_MS);
    queueMicrotask(tick);
    return () => clearInterval(id);
  }, [grid]);

  return { ...state, version };
}

/** Per-frame sighting sections of the published grid (PLAN.md C16), or null until the decoder publishes them. */
export function useFrameSightings(): FrameSightings | null {
  const [sightings, setSightings] = useState<FrameSightings | null>(() => getFrameSightings());
  useEffect(() => onFrameSightings(setSightings), []);
  return sightings;
}
