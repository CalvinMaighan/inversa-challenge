/**
 * The db worker's behaviour behind the RPC table, with every effect injected (store, GraphQL, fetch, clock,
 * events) so it runs under bun against bun:sqlite and fakes. `db.worker.ts` binds it to sqlite-wasm, the gql
 * port and the worker scope.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import type { Op, StoredOp } from "client/threads/crdt/types";
import type { EvfHeader } from "shared/frames";

import { MAX_STALE_MS, queryHash, ttlForQuery } from "./cache";
import {
  allChunks,
  allocGrid,
  chunksWithin,
  chunkUrl,
  copyGridBytes,
  fillGrid,
  frameBody,
  frameIndexExact,
  frameWindow,
  gridShapeFor,
  missingChunks,
  parseEvf,
  readSightings,
  sameGridShape,
  singleFrameEvf,
  COARSE_STEP_MINUTES,
  FINE_STEP_MINUTES,
  type ChunkRequest,
  type FrameWindow,
} from "./frames";
import { ackByIds, dueEntries, markInflight, reconcileFlush, type ApplyResult } from "./outbox";
import type { DbEvent, DbMethod, DbMethods, DbParams, DbResult, DbStats, QuerySource } from "./rpc";
import type { BoardSummary, FrameRow, Store } from "./store";
import type { GqlResult, GqlVariables, Sink, SocketStatus } from "../gql/protocol";

export type EngineGql = {
  request(query: string, variables: GqlVariables, signal?: AbortSignal): Promise<GqlResult>;
  subscribe(query: string, variables: GqlVariables, sink: Sink): () => void;
  readonly socket: SocketStatus;
};

export type EngineOptions = {
  store: Store;
  /** Null until the gql port is linked; `setGql` attaches it. */
  gql: EngineGql | null;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** Absolute or origin-relative `/v1/frames`. */
  framesUrl: string;
  /** Whether grids may live in SharedArrayBuffers. */
  shared: boolean;
  opfs: boolean;
  now?: () => number;
  /** Worker -> main events (`db:grid`, `db:board`, ...). `transfer` lists buffers to move, not copy. */
  post: (event: DbEvent, transfer?: Transferable[]) => void;
  /** Called after a board changes, with its summary (drives the MISSIONS key). */
  onSummary?: (summary: BoardSummary) => void;
  /** Debounce before an automatic outbox flush after a local write. */
  flushDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

const OPS_FIELDS = "seq id hlc boardId entity entityId field value nodeId";
const OPS_SINCE = `query OpsSince($boardId: ID!, $seq: Int!) { opsSince(boardId: $boardId, seq: $seq) { ${OPS_FIELDS} } }`;
const OPS_SUBSCRIPTION = `subscription Ops($boardId: ID!, $afterSeq: Int!) { ops(boardId: $boardId, afterSeq: $afterSeq) { ${OPS_FIELDS} } }`;
const APPLY_OPS = "mutation ApplyOps($boardId: ID!, $ops: [OpInput!]!) { applyOps(boardId: $boardId, ops: $ops) { applied duplicates lastSeq } }";

/** Acked outbox rows older than a day are history. */
const OUTBOX_HISTORY_MS = 24 * 60 * 60_000;
const MAX_FLUSH_ROUNDS = 20;

export class DbEngine {
  private grid: FrameGrid | null = null;
  private window: FrameWindow | null = null;
  private gridPublished = false;
  private lastQuerySource: QuerySource | null = null;
  private readonly boardSubs = new Map<string, () => void>();
  private flushTimer: unknown = null;
  private flushing: Promise<DbResult<"flushOutbox">> | null = null;
  private refreshing: Promise<DbResult<"framesRefresh">> | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  gql: EngineGql | null;

  constructor(private readonly o: EngineOptions) {
    this.gql = o.gql;
    this.now = o.now ?? (() => Date.now());
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get store(): Store {
    return this.o.store;
  }

  setGql(gql: EngineGql): void {
    this.gql = gql;
    // Boards synced before the link only have local state; catch them up now.
    for (const boardId of this.boardSubs.keys()) void this.syncBoard({ boardId });
    if (this.store.outboxDue(this.now()).length > 0) this.scheduleFlush();
  }

  /** Dispatch one RPC call. */
  call<M extends DbMethod>(method: M, params: DbParams<M>): Promise<DbResult<M>> {
    const fn = this[method] as (p: DbParams<M>) => Promise<DbResult<M>> | DbResult<M>;
    if (typeof fn !== "function") return Promise.reject(new Error(`unknown db method ${String(method)}`));
    return Promise.resolve(fn.call(this, params));
  }

  // ---- query (stale-while-revalidate) ------------------------------------------------------

  async query({ query, variables = {} }: DbParams<"query">): Promise<DbResult<"query">> {
    const ttl = ttlForQuery(query);
    if (ttl === 0) return this.finish("network", await this.network(query, variables));
    const hash = queryHash(query, variables);
    const { decision, row } = this.store.decide(hash, this.now());
    if (decision === "fresh" && row) return this.finish("cache", JSON.parse(row.json) as GqlResult);
    if (decision === "stale" && row) {
      void this.revalidate(hash, query, variables, ttl);
      return this.finish("stale", JSON.parse(row.json) as GqlResult);
    }
    const fresh = await this.network(query, variables);
    if (fresh.data !== undefined && !fresh.errors?.length) {
      this.store.putCached(hash, JSON.stringify({ data: fresh.data }), this.now(), ttl);
      return this.finish("network", fresh);
    }
    if (row) return this.finish("fallback", JSON.parse(row.json) as GqlResult);
    return this.finish("network", fresh);
  }

  private finish(source: QuerySource, result: GqlResult): DbResult<"query"> {
    this.lastQuerySource = source;
    return { ...result, source };
  }

  private async revalidate(hash: string, query: string, variables: GqlVariables, ttl: number): Promise<void> {
    const fresh = await this.network(query, variables);
    if (fresh.data !== undefined && !fresh.errors?.length) this.store.putCached(hash, JSON.stringify({ data: fresh.data }), this.now(), ttl);
  }

  private network(query: string, variables: GqlVariables): Promise<GqlResult> {
    if (!this.gql) return Promise.resolve({ errors: [{ message: "gql worker not linked", extensions: { network: true } }], status: 0 });
    return this.gql.request(query, variables);
  }

  // ---- CRDT --------------------------------------------------------------------------------

  applyLocalOps({ boardId, ops }: DbParams<"applyLocalOps">): DbResult<"applyLocalOps"> {
    const now = this.now();
    const outcome = this.store.applyOps(boardId, ops, now);
    this.store.enqueue(boardId, outcome.appliedIds, now);
    this.boardChanged(boardId);
    this.scheduleFlush();
    return { applied: outcome.applied, duplicates: outcome.duplicates, lastSeq: this.store.lastSeq(boardId), pending: this.store.outboxCounts().pending };
  }

  applyRemoteOps({ boardId, ops }: DbParams<"applyRemoteOps">): DbResult<"applyRemoteOps"> {
    const outcome = this.store.applyOps(boardId, ops, this.now());
    // Anything the server or a peer sent back is known to them; ack it whatever its outbox state.
    const acked = ackByIds(this.store.outboxEntries(), ops.map((op) => op.id));
    if (acked.length) this.store.writeOutbox(acked);
    if (outcome.applied > 0 || outcome.confirmed.length > 0) this.boardChanged(boardId);
    return { ...outcome, lastSeq: this.store.lastSeq(boardId) };
  }

  readBoard({ boardId }: DbParams<"readBoard">): DbResult<"readBoard"> {
    return this.store.readBoard(boardId);
  }

  async syncBoard({ boardId }: DbParams<"syncBoard">): Promise<DbResult<"syncBoard">> {
    const gql = this.gql;
    let pulled = 0;
    if (gql) {
      const since = this.store.lastSeq(boardId);
      const res = await gql.request(OPS_SINCE, { boardId, seq: since });
      const ops = (res.data as { opsSince?: StoredOp[] } | undefined)?.opsSince;
      if (ops?.length) pulled = this.applyRemoteOps({ boardId, ops }).applied;
      if (!this.boardSubs.has(boardId)) {
        const off = gql.subscribe(OPS_SUBSCRIPTION, { boardId, afterSeq: this.store.lastSeq(boardId) }, {
          next: (data) => {
            const op = (data as { ops?: StoredOp }).ops;
            if (op) this.applyRemoteOps({ boardId, ops: [op] });
          },
          error: (err) => console.warn("[threads/db] ops subscription", err.message),
        });
        this.boardSubs.set(boardId, off);
      }
      await this.flushOutbox({ boardId });
    } else if (!this.boardSubs.has(boardId)) {
      // Remember the board so `setGql` syncs it once the link arrives.
      this.boardSubs.set(boardId, () => {});
    }
    return { lastSeq: this.store.lastSeq(boardId), pulled, subscribed: Boolean(gql) };
  }

  private boardChanged(boardId: string): void {
    this.o.post({ t: "db:board", boardId });
    this.o.onSummary?.(this.store.summary(boardId));
  }

  // ---- outbox ------------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.gql) return;
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      void this.flushOutbox({});
    }, this.o.flushDelayMs ?? 50);
  }

  flushOutbox({ boardId }: DbParams<"flushOutbox">): Promise<DbResult<"flushOutbox">> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushRounds(boardId).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushRounds(boardId?: string): Promise<DbResult<"flushOutbox">> {
    const totals = { sent: 0, acked: 0, retried: 0 };
    const gql = this.gql;
    if (!gql) return totals;
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
      const now = this.now();
      const due = this.store.outboxDue(now).filter((e) => boardId === undefined || e.boardId === boardId);
      const batch = dueEntries(due, now);
      if (batch.length === 0) break;
      const board = batch[0]!.boardId;
      const inflight = markInflight(batch, now);
      this.store.writeOutbox(inflight);
      const ops = this.store.outboxOps(inflight).map(toOpInput);
      totals.sent += ops.length;
      const res = await gql.request(APPLY_OPS, { boardId: board, ops });
      const result = (res.data as { applyOps?: ApplyResult } | undefined)?.applyOps;
      const outcome = reconcileFlush(inflight, result ?? new Error(res.errors?.map((e) => e.message).join("; ") || "applyOps failed"), this.now());
      this.store.writeOutbox([...outcome.acked, ...outcome.retry]);
      totals.acked += outcome.acked.length;
      totals.retried += outcome.retry.length;
      if (outcome.retry.length) break; // back off; the next flush retries after `nextAt`
    }
    this.store.pruneOutbox(this.now() - OUTBOX_HISTORY_MS);
    return totals;
  }

  // ---- frames ------------------------------------------------------------------------------

  framesRefresh(params: DbParams<"framesRefresh">): Promise<DbResult<"framesRefresh">> {
    if (this.refreshing) return this.refreshing.then(() => this.framesRefresh(params));
    this.refreshing = this.refreshWindow(params).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshWindow({ from, to, force }: DbParams<"framesRefresh">): Promise<DbResult<"framesRefresh">> {
    const w = frameWindow(from, to);
    const sameWindow = this.window !== null && this.window.fromMs === w.fromMs && this.window.toMs === w.toMs;
    if (!sameWindow) {
      this.window = w;
      this.grid = null;
      this.gridPublished = false;
    }
    const cached = this.loadCached(w);
    const chunks = force ? allChunks(w) : missingChunks(w, this.presentTimes(w));
    const { fetched, failed } = await this.fetchChunks(w, chunks);
    this.store.pruneFrames(w.fromMs);
    return { frameCount: w.frameCount, cached, fetched, failed };
  }

  /** Refetch the part of the window a `framesUpdated` range touches. */
  async framesUpdated(from: string, to: string): Promise<void> {
    const w = this.window;
    if (!w) return;
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
    await this.fetchChunks(w, chunksWithin(w, fromMs, toMs));
  }

  private presentTimes(w: FrameWindow): Set<number> {
    const present = this.store.frameTimes(w.coarseStartMs, w.splitMs - 1, COARSE_STEP_MINUTES);
    for (const t of this.store.frameTimes(w.splitMs, w.toMs, FINE_STEP_MINUTES)) present.add(t);
    return present;
  }

  /** Fill the grid from `cache_frames`; returns the number of frames placed. */
  private loadCached(w: FrameWindow): number {
    const rows = [...this.store.getFrames(w.coarseStartMs, w.splitMs - 1, COARSE_STEP_MINUTES), ...this.store.getFrames(w.splitMs, w.toMs, FINE_STEP_MINUTES)];
    let placed = 0;
    for (const r of rows) {
      if (frameIndexExact(w, r.frameAt) < 0) continue;
      try {
        const evf = parseEvf(r.body);
        const grid = this.ensureGrid(w, evf.header);
        placed += fillGrid(grid, w, evf, r.body).length;
      } catch (err) {
        console.warn("[threads/db] dropping unreadable cached frame", r.frameAt, err);
      }
    }
    if (placed > 0) this.publishGrid();
    return placed;
  }

  private ensureGrid(w: FrameWindow, header: EvfHeader): FrameGrid {
    const shape = gridShapeFor(header, w.frameCount);
    if (this.grid && sameGridShape(this.grid.shape, shape)) return this.grid;
    this.grid = allocGrid(shape, this.o.shared);
    this.gridPublished = false;
    return this.grid;
  }

  /** Post the grid to main: the SAB once (bumps thereafter), or a fresh copy each time when not shared. */
  private publishGrid(): void {
    const grid = this.grid;
    const w = this.window;
    if (!grid || !w) return;
    const version = grid.bump();
    if (this.o.shared) {
      if (this.gridPublished) this.o.post({ t: "db:grid-bumped", version });
      else this.o.post({ t: "db:grid", buffer: grid.buffer, window: w });
      this.gridPublished = true;
      return;
    }
    const copy = copyGridBytes(grid);
    this.o.post({ t: "db:grid", buffer: copy, window: w }, [copy]);
    this.gridPublished = true;
  }

  private async fetchChunks(w: FrameWindow, chunks: ChunkRequest[]): Promise<{ fetched: number; failed: number }> {
    let fetched = 0;
    let failed = 0;
    for (const c of chunks) {
      try {
        fetched += await this.fetchChunk(w, c);
      } catch (err) {
        failed += 1;
        console.warn("[threads/db] frames chunk failed", chunkUrl(this.o.framesUrl, c), err);
      }
    }
    return { fetched, failed };
  }

  private async fetchChunk(w: FrameWindow, c: ChunkRequest): Promise<number> {
    const etag = this.store.rangeEtag(c.fromMs, c.toMs, c.stepMinutes);
    const res = await this.o.fetchImpl(chunkUrl(this.o.framesUrl, c), { headers: etag ? { "if-none-match": etag } : {} });
    if (res.status === 304) return 0;
    if (!res.ok) throw new Error(`frames http ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const evf = parseEvf(bytes);
    const grid = this.ensureGrid(w, evf.header);
    const written = fillGrid(grid, w, evf, bytes);
    const now = this.now();
    const newEtag = res.headers.get("etag");
    const rows: FrameRow[] = evf.frames.map((f) => ({
      frameAt: f.atMs,
      step: evf.header.stepMinutes,
      etag: newEtag,
      body: singleFrameEvf(evf.header, f.atMs, frameBody(bytes, f)),
      fetchedAt: now,
    }));
    this.store.putFrames(rows);
    if (written.length > 0) this.publishGrid();
    return written.length;
  }

  framesSnapshot(): DbResult<"framesSnapshot"> {
    if (!this.grid || !this.window) return { buffer: null, window: null };
    return { buffer: copyGridBytes(this.grid), window: this.window };
  }

  frameSightings({ atMs }: DbParams<"frameSightings">): DbResult<"frameSightings"> {
    const w = this.window;
    if (!w) return [];
    const step = atMs >= w.splitMs ? FINE_STEP_MINUTES : COARSE_STEP_MINUTES;
    const row = this.store.getFrames(atMs, atMs, step)[0];
    if (!row) return [];
    const evf = parseEvf(row.body);
    const f = evf.frames[0];
    return f ? readSightings(evf.header, frameBody(row.body, f)) : [];
  }

  // ---- stats -------------------------------------------------------------------------------

  stats(): DbStats {
    return {
      opfs: this.o.opfs,
      frames: this.store.frameCount(),
      cachedQueries: this.store.cachedCount(),
      outbox: this.store.outboxCounts(),
      grid: this.grid ? { frameCount: this.grid.shape.frameCount, version: this.grid.version(), shared: typeof SharedArrayBuffer === "function" && this.grid.buffer instanceof SharedArrayBuffer } : null,
      window: this.window,
      socket: this.gql?.socket ?? "unlinked",
      lastQuerySource: this.lastQuerySource,
    };
  }

  /** Housekeeping on open: stale cache rows and outbox history. */
  housekeeping(): void {
    const now = this.now();
    this.store.pruneCache(now, MAX_STALE_MS);
    this.store.pruneOutbox(now - OUTBOX_HISTORY_MS);
  }

  close(): void {
    for (const off of this.boardSubs.values()) off();
    this.boardSubs.clear();
  }
}

/** `OpInput` has no boardId or seq. */
function toOpInput(op: Op | StoredOp): Record<string, unknown> {
  return { id: op.id, hlc: op.hlc, entity: op.entity, entityId: op.entityId, field: op.field, value: op.value === undefined ? null : op.value, nodeId: op.nodeId };
}

export type { DbMethods };
