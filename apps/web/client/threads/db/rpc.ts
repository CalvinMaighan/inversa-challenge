/**
 * Main <-> db worker RPC: typed method table, the main-side client, and the worker -> main events.
 * Followers call the same methods through `proxy.ts`; the leader's main thread forwards them here.
 *
 * T21 (missions panel, rtc worker) uses: `applyLocalOps`, `flushOutbox`, `readBoard`, `applyRemoteOps`,
 * `syncBoard`. The globe uses the frame grid published by boot.ts, not an RPC.
 */
import type { MessagePortLike } from "@calvinjs/active-state/threads";

import type { Op, StoredOp } from "client/threads/crdt/types";

import type { FrameWindow, Sighting } from "./frames";
import type { OutboxStatus } from "./outbox";
import type { ApplyOutcome, BoardRead } from "./store";
import type { GqlResult, GqlVariables, SocketStatus } from "../gql/protocol";

/** Where a `query` answer came from. */
export type QuerySource = "cache" | "stale" | "network" | "fallback";

export type DbStats = {
  opfs: boolean;
  frames: number;
  cachedQueries: number;
  outbox: Record<OutboxStatus, number>;
  grid: { frameCount: number; version: number; shared: boolean } | null;
  window: FrameWindow | null;
  socket: SocketStatus | "unlinked";
  /** Source of the last `query` call, for diagnostics. */
  lastQuerySource: QuerySource | null;
};

export type DbMethods = {
  query: { params: { query: string; variables?: GqlVariables }; result: GqlResult & { source: QuerySource } };
  applyLocalOps: { params: { boardId: string; ops: Op[] }; result: { applied: number; duplicates: number; lastSeq: number; pending: number } };
  flushOutbox: { params: { boardId?: string }; result: { sent: number; acked: number; retried: number } };
  readBoard: { params: { boardId: string }; result: BoardRead };
  applyRemoteOps: { params: { boardId: string; ops: (Op | StoredOp)[] }; result: ApplyOutcome & { lastSeq: number } };
  syncBoard: { params: { boardId: string }; result: { lastSeq: number; pulled: number; subscribed: boolean } };
  framesRefresh: { params: { from: string; to: string; force?: boolean }; result: { frameCount: number; cached: number; fetched: number; failed: number } };
  framesSnapshot: { params: Record<string, never>; result: { buffer: ArrayBuffer | null; window: FrameWindow | null } };
  frameSightings: { params: { atMs: number }; result: Sighting[] };
  stats: { params: Record<string, never>; result: DbStats };
};

export type DbMethod = keyof DbMethods;
export type DbParams<M extends DbMethod> = DbMethods[M]["params"];
export type DbResult<M extends DbMethod> = DbMethods[M]["result"];

export type ToDb = { t: "db:call"; id: number; method: DbMethod; params: unknown } | { t: "db:link-gql"; port: MessagePort };

export type FromDb =
  | { t: "db:ret"; id: number; ok: true; value: unknown }
  | { t: "db:ret"; id: number; ok: false; error: string }
  | { t: "db:ready"; opfs: boolean }
  | { t: "db:error"; message: string }
  | { t: "db:grid"; buffer: SharedArrayBuffer | ArrayBuffer; window: FrameWindow }
  | { t: "db:grid-bumped"; version: number }
  | { t: "db:board"; boardId: string };

export type DbEvent = Exclude<FromDb, { t: "db:ret" }>;

export function isFromDb(d: unknown): d is FromDb {
  return Boolean(d) && typeof d === "object" && typeof (d as { t?: unknown }).t === "string" && (d as { t: string }).t.startsWith("db:");
}

export function isToDb(d: unknown): d is ToDb {
  return isFromDb(d);
}

export class DbWorkerClient {
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(e: DbEvent) => void>();
  private seq = 0;
  private readonly onEvent = (ev: MessageEvent): void => {
    const m = ev.data as unknown;
    if (!isFromDb(m)) return;
    if (m.t === "db:ret") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
      return;
    }
    for (const cb of this.listeners) cb(m);
  };

  constructor(readonly port: MessagePortLike) {
    port.addEventListener("message", this.onEvent);
    port.start?.();
  }

  call<M extends DbMethod>(method: M, params: DbParams<M>): Promise<DbResult<M>> {
    const id = ++this.seq;
    return new Promise<DbResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ t: "db:call", id, method, params } satisfies ToDb);
    });
  }

  on(cb: (e: DbEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  close(): void {
    this.port.removeEventListener("message", this.onEvent);
    for (const p of this.pending.values()) p.reject(new Error("db client closed"));
    this.pending.clear();
    this.listeners.clear();
  }
}
