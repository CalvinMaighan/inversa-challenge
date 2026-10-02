/**
 * Thread boot (PRD §12 "New tech 1"). `bootThreads()` runs once per tab:
 *
 * 1. Picks the transport: SAB rings when the page is cross-origin isolated, postMessage otherwise.
 * 2. Spawns the gql worker and links the active-state catalog to it with `hostThread`.
 * 3. Runs the Web Locks election. The leader spawns the db worker, links it, and wires a MessageChannel
 *    between the two workers. Followers route db calls to the leader over BroadcastChannel.
 * 4. Surfaces the frame grid and sightings: the leader attaches the SAB (or the transferred ArrayBuffer)
 *    from its worker; followers copy a snapshot from the leader. `api.ts` publishes them to UI code.
 *
 * Threads are per app (PLAN.md C-A5): the workers are named `inversa-gql:<app>` / `inversa-db:<app>` and read
 * their app from `self.name` (every request they make is `/v1/<app>/...`), the db worker opens that app's own
 * SQLite file, and the Web Locks election and BroadcastChannel are per app, so two tabs on different apps never
 * share a leader. Switching apps closes this set and boots the next on first use (`bootThreads`).
 *
 * Workers are spawned with `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })`,
 * which Next 16 / Turbopack bundles as a separate entry (the e2e script drives `next dev` and proves it).
 * If a bundler ever fails to see the URL, the fallback is a static file in `public/workers/` built by a
 * `bun build --target browser` step and `new Worker("/workers/gql.worker.js", { type: "module" })`.
 */
import { get, subscribe } from "@calvinjs/active-state";
import { hostThread, type ChannelKind, type FrameGrid, type ThreadLink } from "@calvinjs/active-state/threads";

import { state } from "client/state";
import { activeAppId } from "client/state/app";
import { TIME, type TimeState } from "client/state/time";
import type { FrameMeta, FrameSightings } from "client/threads/api";
import type { AppId } from "shared/apps";

import { attachGrid } from "./db/frames";
import { createElection, LOCK_NAME, locksAvailable, type Election, type LeaderState } from "./db/leader";
import { createRouter, dbChannelName, type Router } from "./db/proxy";
import { DbWorkerClient, type DbMethod, type DbParams, type DbResult } from "./db/rpc";
import { unpackSightings } from "./db/sightings";
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

export type GridPublication = { grid: FrameGrid; meta: FrameMeta };

/** `inversa-gql:carp`: the worker reads its app back from `self.name`. */
export function workerName(kind: "gql" | "db", app: AppId): string {
  return `inversa-${kind}:${app}`;
}

export type Threads = {
  /** The app these workers serve. */
  readonly app: AppId;
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
  /** Fires with each grid attached on this tab, and again when its contents were bumped. */
  onGrid(cb: (pub: GridPublication) => void): () => void;
  /** Fires with each sightings pack received on this tab. */
  onSightings(cb: (s: FrameSightings) => void): () => void;
  close(): void;
};

let booted: Threads | null = null;

/**
 * The `Threads` of `app` (the active app by default), created on first call. Asking for another app closes the
 * current set first. Throws outside a browser.
 */
export function bootThreads(app: AppId = activeAppId()): Threads {
  if (booted && booted.app === app) return booted;
  booted?.close();
  if (typeof Worker !== "function" || typeof window === "undefined") throw new Error("bootThreads: needs a browser with Worker");
  booted = createThreads(app);
  return booted;
}

export function threadsBooted(): Threads | null {
  return booted;
}

function createThreads(app: AppId): Threads {
  const transport = detectTransport();
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const tabId = crypto.randomUUID();
  const boardListeners = new Set<(boardId: string) => void>();
  const gridListeners = new Set<(pub: GridPublication) => void>();
  const sightingListeners = new Set<(s: FrameSightings) => void>();
  let currentGrid: GridPublication | null = null;
  let currentSightings: FrameSightings | null = null;

  const gqlWorker = new Worker(new URL("./gql.worker.ts", import.meta.url), { type: "module", name: workerName("gql", app) });
  gqlWorker.addEventListener("error", (ev) => console.error("[threads] gql worker error", ev.message || ev));
  const gqlLink = hostThread(gqlWorker, state, { transport });
  const gql = new GqlRpcClient(gqlWorker, "m");

  let dbWorker: Worker | null = null;
  let dbLink: ThreadLink | null = null;
  let dbClient: DbWorkerClient | null = null;
  let dbReady: Promise<void> = Promise.resolve();
  let offTime: (() => void) | null = null;

  const publishGrid = (buffer: SharedArrayBuffer | ArrayBuffer, meta: FrameMeta) => {
    currentGrid = { grid: attachGrid(buffer), meta };
    for (const cb of gridListeners) cb(currentGrid);
  };
  const publishSightings = (s: FrameSightings) => {
    currentSightings = s;
    for (const cb of sightingListeners) cb(s);
  };

  /** Followers copy the leader's grid: into a SAB when the page may share one, else as the plain buffer. */
  const pullSnapshot = async () => {
    const s = (await router.call("framesSnapshot", {})) as DbResult<"framesSnapshot">;
    if (!s.buffer || !s.meta) return;
    if (transport === "sab") {
      const sab = new SharedArrayBuffer(s.buffer.byteLength);
      new Uint8Array(sab).set(new Uint8Array(s.buffer));
      publishGrid(sab, s.meta);
    } else {
      publishGrid(s.buffer, s.meta);
    }
    if (s.sightings) publishSightings(unpackSightings(s.sightings));
  };

  const currentWindow = (): { from: string; to: string } | null => {
    const t = get<TimeState>(TIME);
    return t ? { from: t.from, to: t.to } : null;
  };

  const spawnDb = (): Promise<void> => {
    const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module", name: workerName("db", app) });
    dbWorker = worker;
    dbLink = hostThread(worker, state, { transport });
    const client = new DbWorkerClient(worker);
    dbClient = client;
    const channel = new MessageChannel();
    gqlWorker.postMessage({ t: "gql:link-db", port: channel.port1 } satisfies ToGql, [channel.port1]);
    worker.postMessage({ t: "db:link-gql", port: channel.port2 }, [channel.port2]);

    const ready = new Promise<void>((resolve, reject) => {
      worker.addEventListener("error", (ev) => reject(new Error(`db worker failed to start: ${ev.message || "script error"}`)));
      client.on((e) => {
        switch (e.t) {
          case "db:ready":
            resolve();
            return;
          case "db:error":
            reject(new Error(e.message));
            return;
          case "db:grid":
            publishGrid(e.buffer, e.meta);
            router.broadcast("frames");
            return;
          case "db:grid-bumped":
            if (currentGrid) for (const cb of gridListeners) cb(currentGrid);
            router.broadcast("frames");
            return;
          case "db:sightings":
            publishSightings(unpackSightings(e.pack));
            return;
          case "db:board":
            for (const cb of boardListeners) cb(e.boardId);
            router.broadcast("board", { boardId: e.boardId });
            return;
        }
      });
    });

    // The frame axis follows TIME's bounds; refetch when they move.
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
        name: `${LOCK_NAME}:${app}`,
        onChange: (s) => {
          if (s === "leader") dbReady = spawnDb();
        },
      })
    : null;
  // Without Web Locks (no election possible) this tab runs its own worker.
  const isLeader = () => (election ? election.state === "leader" : true);

  const router: Router = createRouter({
    channel: new BroadcastChannel(dbChannelName(app)),
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
    app,
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
      if (currentGrid) cb(currentGrid);
      return () => {
        gridListeners.delete(cb);
      };
    },
    onSightings(cb) {
      sightingListeners.add(cb);
      if (currentSightings) cb(currentSightings);
      return () => {
        sightingListeners.delete(cb);
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
      if (booted === threads) booted = null;
    },
  };
  return threads;
}
