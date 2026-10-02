"use client";

import { useEffect, useState } from "react";

import { onGlobeReady, type GlobeApi } from "client/globe/api";
import type { LayerStats } from "client/globe/layers/types";

/** Stats are read at most this often; layers change on frame steps and fetches, not every render. */
const SAMPLE_MS = 250;

/** What the legend shows of a stats list; re-render only when it changes. */
export function statsSignature(stats: readonly LayerStats[] | null): string {
  if (!stats) return "";
  return stats.map((s) => `${s.id}:${s.enabled ? 1 : 0}:${s.count}:${s.error ?? ""}:${s.breakdown ? Object.values(s.breakdown).join(",") : ""}`).join("|");
}

/**
 * The globe's per-layer stats (GlobeApi `stats()`, T40), sampled after rendered frames, throttled, plus a slow
 * tick for layers that finish fetching without a visible change. Null until a globe that reports stats is up.
 */
export function useGlobeStats(active = true): LayerStats[] | null {
  const [stats, setStats] = useState<LayerStats[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let api: GlobeApi | null = null;
    let offRender = () => {};
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let signature = "";

    const sample = () => {
      pending = null;
      last = performance.now();
      const next = api?.stats?.() ?? null;
      const sig = statsSignature(next);
      if (sig === signature) return;
      signature = sig;
      setStats(next);
    };
    const schedule = () => {
      if (pending) return;
      const wait = Math.max(0, SAMPLE_MS - (performance.now() - last));
      pending = setTimeout(sample, wait);
    };

    const offReady = onGlobeReady((g) => {
      offRender();
      api = g;
      offRender = g.onPostRender(schedule);
      schedule();
    });
    const tick = setInterval(schedule, 1_000);
    return () => {
      offReady();
      offRender();
      clearInterval(tick);
      if (pending) clearTimeout(pending);
    };
  }, [active]);

  return stats;
}
