/**
 * The db worker's behaviour behind the RPC table, with every effect injected (store, GraphQL, fetch, clock,
 * events) so it runs under bun against bun:sqlite and fakes. `db.worker.ts` binds it to sqlite-wasm, the gql
 * port and the worker scope.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import type { FrameMeta } from "client/threads/api";
import type { Op, StoredOp } from "client/threads/crdt/types";
import type { EvfHeader } from "shared/frames";

import { MAX_STALE_MS, queryHash, ttlForQuery } from "./cache";
import {
  allChunks,
  allocGrid,
  axisEndMs,
  chunksWithin,
  chunkUrl,
  copyGridBytes,
  fillGrid,
  frameAxis,
  frameBody,
  frameIndexExact,
  frameMetaFor,
  gridShapeFor,
  missingChunks,
  parseEvf,
  readSightings,
  sameAxis,
  sameGridShape,
  sightingBytes,
  singleFrameEvf,
  STEP_MINUTES,
  type ChunkRequest,
  type FrameAxis,
} from "./frames";
import { ackByIds, dueEntries, markInflight, reconcileFlush, type ApplyResult } from "./outbox";
import type { DbEvent, DbMethod, DbMethods, DbParams, DbResult, DbStats, QuerySource } from "./rpc";
import { clonePack, packSightings, packTransfer, totalSightings, type SightingsPack } from "./sightings";
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

/** Chunk requests in flight at once. */
const FETCH_LANES = 4;

const OPS_FIELDS = "seq id hlc boardId entity entityId field value nodeId";
const OPS_SINCE = `query OpsSince($boardId: ID!, $seq: Int!) { opsSince(boardId: $boardId, seq: $seq) { ${OPS_FIELDS} } }`;
const OPS_SUBSCRIPTION = `subscription Ops($boardId: ID!, $afterSeq: Int!) { ops(boardId: $boardId, afterSeq: $afterSeq) { ${OPS_FIELDS} } }`;
const APPLY_OPS = "mutation ApplyOps($boardId: ID!, $ops: [OpInput!]!) { applyOps(boardId: $boardId, ops: $ops) { applied duplicates lastSeq } }";

/** Acked outbox rows older than a day are history. */
const OUTBOX_HISTORY_MS = 24 * 60 * 60_000;
const MAX_FLUSH_ROUNDS = 20;

export class DbEngine {
  private grid: FrameGrid | null = null;
  private axis: FrameAxis | null = null;
  private meta: FrameMeta | null = null;
  /** Raw sighting records per frame index; null until that frame has been filled. */
  private sightings: (Uint8Array | null)[] = [];
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
    const axis = frameAxis(from, to);
    if (!this.axis || !sameAxis(this.axis, axis)) {
      this.axis = axis;
      this.grid = null;
      this.meta = null;
      this.sightings = new Array<Uint8Array | null>(axis.frameCount).fill(null);
      this.gridPublished = false;
    }
    const cached = this.loadCached(axis);
    const chunks = force ? allChunks(axis) : missingChunks(axis, this.presentTimes(axis));
    const { fetched, failed } = await this.fetchChunks(axis, chunks);
    this.store.pruneFrames(axis.frame0UnixMs);
    return { frameCount: axis.frameCount, cached, fetched, failed };
  }

  /**
   * Axum wrote rows and rebuilt frames: expire the query cache (alerts, sightings, readings ... read after this
   * must not come from before it) and refetch the part of the axis the range touches.
   */
  async framesUpdated(from: string, to: string): Promise<void> {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
    this.store.expireCached();
    const axis = this.axis;
    if (!axis) return;
    await this.fetchChunks(axis, chunksWithin(axis, fromMs, toMs));
  }

  private presentTimes(axis: FrameAxis): Set<number> {
    const end = axisEndMs(axis);
    return end === null ? new Set() : this.store.frameTimes(axis.frame0UnixMs, end, STEP_MINUTES);
  }

  /** Fill the grid from `cache_frames`; returns the number of frames placed. */
  private loadCached(axis: FrameAxis): number {
    const end = axisEndMs(axis);
    if (end === null) return 0;
    let placed = 0;
    for (const r of this.store.getFrames(axis.frame0UnixMs, end, STEP_MINUTES)) {
      if (frameIndexExact(axis, r.frameAt) < 0) continue;
      try {
        const evf = parseEvf(r.body);
        placed += this.place(axis, evf, r.body).length;
      } catch (err) {
        console.warn("[threads/db] dropping unreadable cached frame", r.frameAt, err);
      }
    }
    if (placed > 0) this.publishGrid();
    return placed;
  }

  /** Write a parsed body's frames into the grid and keep their sighting bytes. */
  private place(axis: FrameAxis, evf: ReturnType<typeof parseEvf>, bytes: Uint8Array): number[] {
    const grid = this.ensureGrid(axis, evf.header);
    const written = fillGrid(grid, axis, evf, bytes);
    for (const [index, f] of written) this.sightings[index] = sightingBytes(evf.header, frameBody(bytes, f)).slice();
    return written.map(([index]) => index);
  }

  private ensureGrid(axis: FrameAxis, header: EvfHeader): FrameGrid {
    const shape = gridShapeFor(header, axis.frameCount);
    if (this.grid && sameGridShape(this.grid.shape, shape)) return this.grid;
    this.grid = allocGrid(shape, this.o.shared);
    this.meta = frameMetaFor(axis, header);
    this.gridPublished = false;
    return this.grid;
  }

  /**
   * Post the grid and its sightings to main: the SAB once (bumps thereafter), or a fresh copy each time
   * when not shared. Sightings are small, so a new pack goes out with every publish.
   */
  private publishGrid(): void {
    const grid = this.grid;
    const meta = this.meta;
    if (!grid || !meta) return;
    const version = grid.bump();
    if (this.o.shared) {
      if (this.gridPublished) this.o.post({ t: "db:grid-bumped", version });
      else this.o.post({ t: "db:grid", buffer: grid.buffer, meta });
    } else {
      const copy = copyGridBytes(grid);
      this.o.post({ t: "db:grid", buffer: copy, meta }, [copy]);
    }
    this.gridPublished = true;
    const pack = packSightings(this.sightings);
    this.o.post({ t: "db:sightings", pack }, packTransfer(pack));
  }

  private async fetchChunks(axis: FrameAxis, chunks: ChunkRequest[]): Promise<{ fetched: number; failed: number }> {
    let fetched = 0;
    let failed = 0;
    // Newest first, a few at a time: the recent days a visitor looks at first arrive first, and two years of chunks
    // do not queue one behind another.
    const queue = [...chunks].reverse();
    const lane = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          fetched += await this.fetchChunk(axis, c);
        } catch (err) {
          failed += 1;
          console.warn("[threads/db] frames chunk failed", chunkUrl(this.o.framesUrl, c), err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_LANES, queue.length) }, lane));
    return { fetched, failed };
  }

  private async fetchChunk(axis: FrameAxis, c: ChunkRequest): Promise<number> {
    const etag = this.store.rangeEtag(c.fromMs, c.toMs, c.stepMinutes);
    const res = await this.o.fetchImpl(chunkUrl(this.o.framesUrl, c), { headers: etag ? { "if-none-match": etag } : {} });
    if (res.status === 304) return 0;
    if (!res.ok) throw new Error(`frames http ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const evf = parseEvf(bytes);
    const written = this.place(axis, evf, bytes);
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
    if (!this.grid || !this.meta) return { buffer: null, meta: null, sightings: null };
    return { buffer: copyGridBytes(this.grid), meta: this.meta, sightings: clonePack(packSightings(this.sightings)) };
  }

  frameSightings({ atMs }: DbParams<"frameSightings">): DbResult<"frameSightings"> {
    const row = this.store.getFrames(atMs, atMs, STEP_MINUTES)[0];
    if (!row) return [];
    const evf = parseEvf(row.body);
    const f = evf.frames[0];
    return f ? readSightings(evf.header, frameBody(row.body, f)) : [];
  }

  /** The current sightings pack (tests). */
  sightingsPack(): SightingsPack {
    return packSightings(this.sightings);
  }

  // ---- stats -------------------------------------------------------------------------------

  stats(): DbStats {
    return {
      opfs: this.o.opfs,
      frames: this.store.frameCount(),
      cachedQueries: this.store.cachedCount(),
      outbox: this.store.outboxCounts(),
      grid: this.grid ? { frameCount: this.grid.shape.frameCount, version: this.grid.version(), shared: typeof SharedArrayBuffer === "function" && this.grid.buffer instanceof SharedArrayBuffer } : null,
      meta: this.meta,
      sightings: totalSightings(packSightings(this.sightings)),
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
