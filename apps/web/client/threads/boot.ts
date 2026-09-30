/**
 * Thread boot (PRD §12 "New tech 1"). `bootThreads()` runs once per tab:
 *
 * 1. Picks the transport: SAB rings when the page is cross-origin isolated, postMessage otherwise.
 * 2. Spawns the gql worker and links the active-state catalog to it with `hostThread`.
 * 3. Runs the Web Locks election. The leader spawns the db worker, links it, and wires a MessageChannel
 *    between the two workers. Followers route db calls to the leader over BroadcastChannel.
 * 4. Publishes the frame grid: the leader attaches the SAB (or the transferred ArrayBuffer) from its worker;
 *    followers copy a snapshot from the leader.
 *
 * Workers are spawned with `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })`,
 * which Next 16 / Turbopack bundles as a separate entry (the e2e script drives `next dev` and proves it).
 * If a bundler ever fails to see the URL, the fallback is a static file in `public/workers/` built by a
 * `bun build --target browser` step and `new Worker("/workers/gql.worker.js", { type: "module" })`.
 */
import { get, subscribe } from "@calvinjs/active-state";
import { hostThread, type ChannelKind, type ThreadLink } from "@calvinjs/active-state/threads";

import { state } from "client/state";
import { TIME, type TimeState } from "client/state/time";

import { attachGrid, type FrameWindow } from "./db/frames";
import { createElection, locksAvailable, type Election, type LeaderState } from "./db/leader";
import { CHANNEL_NAME, createRouter, type Router } from "./db/proxy";
import { DbWorkerClient, type DbMethod, type DbParams, type DbResult } from "./db/rpc";
import { GqlRpcClient, type ToGql } from "./gql/protocol";

export type ThreadsTransport = ChannelKind;

export type TransportEnv = {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  /** Test hook: force the postMessage transport. */
  forceMessage?: boolean;
};

/** SAB rings need both the constructor and isolation; anything less falls back to postMessage. */
export function chooseTransport(env: TransportEnv): ThreadsTransport {
  if (env.forceMessage) return "message";
  return env.crossOriginIsolated && env.sharedArrayBuffer ? "sab" : "message";
}

export function detectTransport(): ThreadsTransport {
  return chooseTransport({
    crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
  });
}

export type GridPublication = { grid: ReturnType<typeof attachGrid>; window: FrameWindow };

export type Threads = {
  readonly transport: ThreadsTransport;
  readonly isolated: boolean;
  readonly gql: GqlRpcClient;
  /** Resolves once the election settled and, for the leader, the db worker reported ready. */
  readonly ready: Promise<void>;
  readonly leaderState: () => LeaderState;
  readonly isLeader: () => boolean;
  /** A db RPC, local on the leader, proxied on a follower. */
  db<M extends DbMethod>(method: M, params: DbParams<M>): Promise<DbResult<M>>;
  /** Fires when the leader (this tab or another) reports that board rows changed. */
  onBoardChanged(cb: (boardId: string) => void): () => void;
  /** Fires with each grid attached on this tab. */
  onGrid(cb: (pub: GridPublication) => void): () => void;
  close(): void;
};

let booted: Threads | null = null;

/** The `Threads` singleton, created on first call. Throws outside a browser. */
export function bootThreads(): Threads {
  if (booted) return booted;
  if (typeof Worker !== "function" || typeof window === "undefined") throw new Error("bootThreads: needs a browser with Worker");
  booted = createThreads();
  return booted;
}

export function threadsBooted(): Threads | null {
  return booted;
}

function createThreads(): Threads {
  const transport = detectTransport();
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const tabId = crypto.randomUUID();
  const boardListeners = new Set<(boardId: string) => void>();
  const gridListeners = new Set<(pub: GridPublication) => void>();
  let current: GridPublication | null = null;

  const gqlWorker = new Worker(new URL("./gql.worker.ts", import.meta.url), { type: "module", name: "inversa-gql" });
  gqlWorker.addEventListener("error", (ev) => console.error("[threads] gql worker error", ev.message || ev));
  const gqlLink = hostThread(gqlWorker, state, { transport });
  const gql = new GqlRpcClient(gqlWorker, "m");

  let dbWorker: Worker | null = null;
  let dbLink: ThreadLink | null = null;
  let dbClient: DbWorkerClient | null = null;
  let dbReady: Promise<void> = Promise.resolve();
  let offTime: (() => void) | null = null;

  const publish = (buffer: SharedArrayBuffer | ArrayBuffer, window: FrameWindow) => {
    current = { grid: attachGrid(buffer), window };
    for (const cb of gridListeners) cb(current);
  };

  /** Followers copy the leader's grid: into a SAB when the page may share one, else as the plain buffer. */
  const pullSnapshot = async () => {
    const snap = await router.call("framesSnapshot", {});
    const s = snap as DbResult<"framesSnapshot">;
    if (!s.buffer || !s.window) return;
    if (transport === "sab") {
      const sab = new SharedArrayBuffer(s.buffer.byteLength);
      new Uint8Array(sab).set(new Uint8Array(s.buffer));
      publish(sab, s.window);
    } else {
      publish(s.buffer, s.window);
    }
  };

  const currentWindow = (): { from: string; to: string } | null => {
    const t = get<TimeState>(TIME);
    return t ? { from: t.from, to: t.to } : null;
  };

  const spawnDb = (): Promise<void> => {
    dbWorker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module", name: "inversa-db" });
    dbLink = hostThread(dbWorker, state, { transport });
    const client = new DbWorkerClient(dbWorker);
    dbClient = client;
    const channel = new MessageChannel();
    gqlWorker.postMessage({ t: "gql:link-db", port: channel.port1 } satisfies ToGql, [channel.port1]);
    dbWorker.postMessage({ t: "db:link-gql", port: channel.port2 }, [channel.port2]);

    const ready = new Promise<void>((resolve, reject) => {
      dbWorker!.addEventListener("error", (ev) => reject(new Error(`db worker failed to start: ${ev.message || "script error"}`)));
      client.on((e) => {
        switch (e.t) {
          case "db:ready":
            resolve();
            return;
          case "db:error":
            reject(new Error(e.message));
            return;
          case "db:grid":
            publish(e.buffer, e.window);
            router.broadcast("frames");
            return;
          case "db:grid-bumped":
            if (current) for (const cb of gridListeners) cb(current);
            router.broadcast("frames");
            return;
          case "db:board":
            for (const cb of boardListeners) cb(e.boardId);
            router.broadcast("board", { boardId: e.boardId });
            return;
        }
      });
    });

    // The frame window follows TIME's bounds; refetch when they move.
    let last: string | null = null;
    const refresh = () => {
      const w = currentWindow();
      if (!w) return;
      const key = `${w.from}|${w.to}`;
      if (key === last) return;
      last = key;
      void client.call("framesRefresh", w).catch((err: unknown) => console.warn("[threads] framesRefresh", err));
    };
    void ready.then(refresh);
    offTime = subscribe(TIME, refresh);
    return ready;
  };

  const election: Election | null = locksAvailable()
    ? createElection({
        locks: navigator.locks,
        onChange: (s) => {
          if (s === "leader") dbReady = spawnDb();
        },
      })
    : null;
  // Without Web Locks (no election possible) this tab runs its own worker.
  const isLeader = () => (election ? election.state === "leader" : true);

  const router: Router = createRouter({
    channel: new BroadcastChannel(CHANNEL_NAME),
    tabId,
    isLeader,
    local: (method, params) => {
      if (!dbClient) return Promise.reject(new Error("db worker not started"));
      return dbReady.then(() => dbClient!.call(method as DbMethod, params as never));
    },
    onEvent: (event, detail) => {
      if (event === "frames") void pullSnapshot().catch((err: unknown) => console.warn("[threads] frames snapshot", err));
      if (event === "board") for (const cb of boardListeners) cb((detail as { boardId: string }).boardId);
    },
  });

  if (!election) dbReady = spawnDb();

  const ready: Promise<void> = (election ? election.settled : Promise.resolve("leader" as const)).then(async (role) => {
    if (role === "leader") await dbReady;
    else await pullSnapshot().catch(() => {});
  });

  const release = () => election?.close();
  window.addEventListener("pagehide", release);

  const threads: Threads = {
    transport,
    isolated,
    gql,
    ready,
    leaderState: () => election?.state ?? "leader",
    isLeader,
    db: (method, params) => router.call(method, params) as Promise<DbResult<typeof method>>,
    onBoardChanged(cb) {
      boardListeners.add(cb);
      return () => {
        boardListeners.delete(cb);
      };
    },
    onGrid(cb) {
      gridListeners.add(cb);
      if (current) cb(current);
      return () => {
        gridListeners.delete(cb);
      };
    },
    close() {
      window.removeEventListener("pagehide", release);
      offTime?.();
      router.close();
      election?.close();
      dbClient?.close();
      dbLink?.close();
      dbWorker?.terminate();
      gql.close();
      gqlLink.close();
      gqlWorker.terminate();
      booted = null;
    },
  };
  return threads;
}
