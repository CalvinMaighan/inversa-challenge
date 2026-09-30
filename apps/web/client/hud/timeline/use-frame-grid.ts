"use client";

import { useEffect, useState } from "react";
import type { FrameGrid } from "@calvinjs/active-state/threads";

import { getFrameGrid, onFrameGrid } from "client/threads/api";

/** How often the timeline checks the grid version. The timeline summary (gaps, sparkline) is not frame-critical. */
const VERSION_POLL_MS = 500;

/**
 * The published frame grid and its write version. Polls `version()` (one atomic load) instead of
 * `waitVersion`, whose fallback without `Atomics.waitAsync` spins a 1 ms timer on the main thread.
 */
export function useFrameGrid(): { grid: FrameGrid | null; version: number } {
  const [grid, setGrid] = useState<FrameGrid | null>(() => getFrameGrid());
  const [version, setVersion] = useState(() => getFrameGrid()?.version() ?? 0);

  useEffect(() => onFrameGrid((next) => setGrid(next)), []);

  useEffect(() => {
    if (!grid) return;
    const tick = () => setVersion(grid.version());
    const id = setInterval(tick, VERSION_POLL_MS);
    queueMicrotask(tick);
    return () => clearInterval(id);
  }, [grid]);

  return { grid, version };
}
