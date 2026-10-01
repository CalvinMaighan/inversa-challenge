"use client";

/**
 * Dev-only harness for the thread boot (T19). Boots the workers on mount and exposes `window.__threads`
 * for `e2e/dbworker.ts`; renders a status line for a human. app/dev/layout.tsx 404s it in production builds
 * unless INVERSA_DEV_ROUTES=1.
 */

import { useEffect, useState } from "react";

import { getFrameGrid, getFrameMeta, getFrameSightings, gqlRequest, type FrameMeta } from "client/threads/api";
import { bootThreads, type Threads } from "client/threads/boot";
import { dbChannelName } from "client/threads/db/proxy";
import type { DbStats } from "client/threads/db/rpc";

type Info = {
  transport: Threads["transport"];
  isolated: boolean;
  leader: boolean;
  leaderState: string;
  grid: { frameCount: number; version: number; shared: boolean } | null;
  meta: FrameMeta | null;
  /** Total sighting records published on this tab, or -1 before any. */
  sightings: number;
  /** Follower calls this tab answered over BroadcastChannel (leader only). */
  proxied: number;
};

type Harness = {
  status: "booting" | "ready" | "error";
  error?: string;
  gqlRequest: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  stats: () => Promise<DbStats>;
  info: () => Info;
  close: () => void;
};

declare global {
  interface Window {
    __threads?: Harness;
  }
}

function install(setLine: (s: string) => void): () => void {
  const threads = bootThreads();
  let proxied = 0;
  // The leader's channel for this app: a follower's db requests arrive here.
  const bc = new BroadcastChannel(dbChannelName(threads.app));
  bc.addEventListener("message", (ev) => {
    const d = ev.data as { t?: string } | null;
    if (d?.t === "db:req" && threads.isLeader()) proxied += 1;
  });
  const info = (): Info => {
    const grid = getFrameGrid();
    const s = getFrameSightings();
    let sightings = -1;
    if (s) {
      sightings = 0;
      for (const n of s.counts) sightings += n;
    }
    return {
      transport: threads.transport,
      isolated: threads.isolated,
      leader: threads.isLeader(),
      leaderState: threads.leaderState(),
      grid: grid ? { frameCount: grid.shape.frameCount, version: grid.version(), shared: typeof SharedArrayBuffer === "function" && grid.buffer instanceof SharedArrayBuffer } : null,
      meta: getFrameMeta(),
      sightings,
      proxied,
    };
  };
  const harness: Harness = {
    status: "booting",
    gqlRequest: (query, variables) => gqlRequest(query, variables ?? {}),
    stats: () => threads.db("stats", {}),
    info,
    close: () => threads.close(),
  };
  window.__threads = harness;
  const render = () => {
    const i = info();
    setLine(`${harness.status} · ${i.transport} · isolated=${i.isolated} · ${i.leaderState} · grid=${i.grid ? `${i.grid.frameCount}f v${i.grid.version}` : "none"} · sightings=${i.sightings}`);
  };
  threads.ready.then(
    () => {
      harness.status = "ready";
      render();
    },
    (err: unknown) => {
      harness.status = "error";
      harness.error = err instanceof Error ? err.message : String(err);
      render();
    },
  );
  const offGrid = threads.onGrid(render);
  const offSightings = threads.onSightings(render);
  const timer = setInterval(render, 1000);
  render();
  return () => {
    clearInterval(timer);
    offGrid();
    offSightings();
    bc.close();
    delete window.__threads;
  };
}

export default function ThreadsDevPage() {
  const [line, setLine] = useState("booting");
  useEffect(() => install(setLine), []);
  return (
    <main style={{ padding: 16, fontFamily: "var(--font-jetbrains-mono), monospace" }}>
      <h1 style={{ fontSize: 16 }}>threads</h1>
      <p data-testid="threads-status">{line}</p>
    </main>
  );
}
