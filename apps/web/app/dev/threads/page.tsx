"use client";

/**
 * Dev-only harness for the thread boot (T19). Boots the workers on mount and exposes `window.__threads`
 * for `e2e/dbworker.ts`; renders a status line for a human. 404 in production builds.
 */
import { notFound } from "next/navigation";
import { useEffect, useState } from "react";

import { get } from "@calvinjs/active-state";

import { FEEDS } from "client/state/feeds";
import { getFrameGrid, getFrameWindow, gqlRequest } from "client/threads/api";
import { bootThreads, type Threads } from "client/threads/boot";
import { CHANNEL_NAME } from "client/threads/db/proxy";
import type { DbStats } from "client/threads/db/rpc";

type Info = {
  transport: Threads["transport"];
  isolated: boolean;
  leader: boolean;
  leaderState: string;
  grid: { frameCount: number; version: number; shared: boolean } | null;
  window: { fromMs: number; toMs: number; frameCount: number } | null;
  feeds: number;
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
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.addEventListener("message", (ev) => {
    const d = ev.data as { t?: string } | null;
    if (d?.t === "db:req" && threads.isLeader()) proxied += 1;
  });
  const info = (): Info => {
    const grid = getFrameGrid();
    const w = getFrameWindow();
    return {
      transport: threads.transport,
      isolated: threads.isolated,
      leader: threads.isLeader(),
      leaderState: threads.leaderState(),
      grid: grid ? { frameCount: grid.shape.frameCount, version: grid.version(), shared: typeof SharedArrayBuffer === "function" && grid.buffer instanceof SharedArrayBuffer } : null,
      window: w ? { fromMs: w.fromMs, toMs: w.toMs, frameCount: w.frameCount } : null,
      feeds: (get<unknown[]>(FEEDS) ?? []).length,
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
    setLine(`${harness.status} · ${i.transport} · isolated=${i.isolated} · ${i.leaderState} · grid=${i.grid ? `${i.grid.frameCount}f v${i.grid.version}` : "none"} · feeds=${i.feeds}`);
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
  const timer = setInterval(render, 1000);
  render();
  return () => {
    clearInterval(timer);
    offGrid();
    bc.close();
    delete window.__threads;
  };
}

export default function ThreadsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const [line, setLine] = useState("booting");
  useEffect(() => install(setLine), []);
  return (
    <main style={{ padding: 16, fontFamily: "var(--font-jetbrains-mono), monospace" }}>
      <h1 style={{ fontSize: 16 }}>threads</h1>
      <p data-testid="threads-status">{line}</p>
    </main>
  );
}
