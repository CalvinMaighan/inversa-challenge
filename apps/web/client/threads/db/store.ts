/**
 * The local store over a minimal SQL driver. The db worker binds it to sqlite-wasm; tests bind it to
 * bun:sqlite and run the same statements. CRDT merges use T12's rule functions (`crdt/merge.ts`) row by row,
 * so the SQL tables converge exactly like the in-memory board.
 */
import { isDeleted, mergeCounter, messageValue, messageWins, orderMessages, registerWins, validateOp, InvalidOpError, type BoardView } from "client/threads/crdt/merge";
import { DELETED_FIELD, type Op, type StoredOp } from "client/threads/crdt/types";

import { cacheDecision, type CacheDecision, type CacheRow } from "./cache";
import { INFLIGHT_STALE_MS, type OutboxEntry, type OutboxStatus } from "./outbox";
import { SCHEMA_STATEMENTS, SCHEMA_UPGRADES, SCHEMA_VERSION } from "./schema";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlDb {
  run(sql: string, params?: SqlValue[]): void;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
}

export type FrameRow = { frameAt: number; step: number; etag: string | null; body: Uint8Array; fetchedAt: number };

export type ApplyOutcome = {
  applied: number;
  duplicates: number;
  /** Ids newly applied by this batch, in order. */
  appliedIds: string[];
  /** Ids of ops that arrived with a server seq and were already local (our own writes coming back). */
  confirmed: string[];
  /** Highest seq seen in this batch, or null when none carried one. */
  maxSeq: number | null;
};

export type BoardSummary = { boardId: string; lastSeq: number; missionCount: number; removalTotal: number; messageCount: number };

export type BoardRead = BoardView & { id: string; lastSeq: number };

/** LWW register tables are named after their entity: `missions`, `notes`. */
const registerTable = (entity: "mission" | "note"): string => `${entity}s`;

const num = (v: SqlValue): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0));
const str = (v: SqlValue): string => (typeof v === "string" ? v : String(v ?? ""));
const json = (v: unknown): string => JSON.stringify(v === undefined ? null : v);

export class Store {
  constructor(readonly db: SqlDb) {}

  migrate(): void {
    for (const sql of SCHEMA_STATEMENTS) this.db.run(sql);
    for (const sql of SCHEMA_UPGRADES) {
      try {
        this.db.run(sql);
      } catch {
        // The column exists: a fresh schema or an earlier upgrade.
      }
    }
    this.db.run("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  }

  // ---- cache_queries ----------------------------------------------------------------------

  getCached(hash: string): CacheRow | null {
    const row = this.db.all("SELECT hash, json, fetched_at, ttl FROM cache_queries WHERE hash = ?", [hash])[0];
    return row ? { hash: str(row.hash), json: str(row.json), fetchedAt: num(row.fetched_at), ttlMs: num(row.ttl) } : null;
  }

  decide(hash: string, nowMs: number): { decision: CacheDecision; row: CacheRow | null } {
    const row = this.getCached(hash);
    return { decision: cacheDecision(row, nowMs), row };
  }

  putCached(hash: string, body: string, fetchedAt: number, ttlMs: number): void {
    this.db.run("INSERT OR REPLACE INTO cache_queries (hash, json, fetched_at, ttl) VALUES (?, ?, ?, ?)", [hash, body, fetchedAt, ttlMs]);
  }

  /**
   * New rows landed upstream: every cached body is out of date. TTL 0 makes the next read a miss (network
   * first) while the row stays as the offline fallback; `putCached` restores the TTL on refetch.
   */
  expireCached(): void {
    this.db.run("UPDATE cache_queries SET ttl = 0");
  }

  cachedCount(): number {
    return num(this.db.all("SELECT COUNT(*) AS n FROM cache_queries")[0]?.n ?? 0);
  }

  /** Drop rows older than their TTL by more than `maxStaleMs`. Returns the count removed. */
  pruneCache(nowMs: number, maxStaleMs: number): number {
    const before = num(this.db.all("SELECT COUNT(*) AS n FROM cache_queries")[0]?.n ?? 0);
    this.db.run("DELETE FROM cache_queries WHERE fetched_at + ttl + ? < ?", [maxStaleMs, nowMs]);
    const after = num(this.db.all("SELECT COUNT(*) AS n FROM cache_queries")[0]?.n ?? 0);
    return before - after;
  }

  // ---- cache_frames -----------------------------------------------------------------------

  putFrames(rows: readonly FrameRow[]): void {
    this.db.transaction(() => {
      for (const r of rows) {
        this.db.run("INSERT OR REPLACE INTO cache_frames (frame_at, step, etag, body, fetched_at) VALUES (?, ?, ?, ?, ?)", [
          r.frameAt,
          r.step,
          r.etag,
          r.body,
          r.fetchedAt,
        ]);
      }
    });
  }

  /** Frames at `step` with `fromMs <= frame_at <= toMs`, ascending. */
  getFrames(fromMs: number, toMs: number, step: number): FrameRow[] {
    return this.db
      .all("SELECT frame_at, step, etag, body, fetched_at FROM cache_frames WHERE step = ? AND frame_at BETWEEN ? AND ? ORDER BY frame_at", [step, fromMs, toMs])
      .map((r) => ({ frameAt: num(r.frame_at), step: num(r.step), etag: r.etag === null ? null : str(r.etag), body: r.body as Uint8Array, fetchedAt: num(r.fetched_at) }));
  }

  /** Timestamps of cached frames at `step` inside the range. */
  frameTimes(fromMs: number, toMs: number, step: number): Set<number> {
    return new Set(this.db.all("SELECT frame_at FROM cache_frames WHERE step = ? AND frame_at BETWEEN ? AND ?", [step, fromMs, toMs]).map((r) => num(r.frame_at)));
  }

  /** The etag shared by every frame in the range when they all agree, else null. */
  rangeEtag(fromMs: number, toMs: number, step: number): string | null {
    const rows = this.db.all("SELECT DISTINCT etag FROM cache_frames WHERE step = ? AND frame_at BETWEEN ? AND ?", [step, fromMs, toMs]);
    return rows.length === 1 && rows[0]!.etag !== null ? str(rows[0]!.etag) : null;
  }

  /** Drop frames outside the resident window (older than `keepFromMs`). */
  pruneFrames(keepFromMs: number): void {
    this.db.run("DELETE FROM cache_frames WHERE frame_at < ?", [keepFromMs]);
  }

  frameCount(): number {
    return num(this.db.all("SELECT COUNT(*) AS n FROM cache_frames")[0]?.n ?? 0);
  }

  // ---- CRDT -------------------------------------------------------------------------------

  hasOp(id: string): boolean {
    return this.db.all("SELECT 1 AS one FROM ops WHERE id = ?", [id]).length > 0;
  }

  /**
   * Apply a batch to the board tables, T12 rules, idempotent on id. The batch is validated first and rejected
   * whole on an invalid op, like `merge.applyOps`. Ops carrying a `seq` update an existing row's seq.
   */
  applyOps(boardId: string, ops: readonly (Op | StoredOp)[], nowMs: number): ApplyOutcome {
    for (const op of ops) {
      const reason = validateOp(op, boardId);
      if (reason) throw new InvalidOpError(String(op.id), reason);
    }
    return this.db.transaction(() => {
      const out: ApplyOutcome = { applied: 0, duplicates: 0, appliedIds: [], confirmed: [], maxSeq: null };
      for (const op of ops) {
        const seq = "seq" in op && typeof op.seq === "number" ? op.seq : null;
        if (seq !== null) out.maxSeq = out.maxSeq === null ? seq : Math.max(out.maxSeq, seq);
        const existing = this.db.all("SELECT seq FROM ops WHERE id = ?", [op.id])[0];
        if (existing) {
          out.duplicates += 1;
          if (seq !== null && existing.seq === null) {
            this.db.run("UPDATE ops SET seq = ? WHERE id = ?", [seq, op.id]);
            out.confirmed.push(op.id);
          }
          continue;
        }
        this.db.run("INSERT INTO ops (id, seq, hlc, board_id, entity, entity_id, field, value, node_id, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          op.id,
          seq,
          op.hlc,
          boardId,
          op.entity,
          op.entityId,
          op.field,
          json(op.value),
          op.nodeId,
          nowMs,
        ]);
        out.applied += 1;
        out.appliedIds.push(op.id);
        this.merge(boardId, op);
      }
      return out;
    });
  }

  private merge(boardId: string, op: Op): void {
    switch (op.entity) {
      case "mission":
      case "note": {
        const table = registerTable(op.entity);
        const row = this.db.all(`SELECT hlc FROM ${table} WHERE board_id = ? AND id = ? AND field = ?`, [boardId, op.entityId, op.field])[0];
        if (registerWins(row ? str(row.hlc) : undefined, op.hlc)) {
          this.db.run(`INSERT OR REPLACE INTO ${table} (board_id, id, field, value, hlc) VALUES (?, ?, ?, ?, ?)`, [boardId, op.entityId, op.field, json(op.value), op.hlc]);
        }
        return;
      }
      case "message": {
        const row = this.db.all("SELECT hlc FROM messages WHERE board_id = ? AND id = ?", [boardId, op.entityId])[0];
        if (messageWins(row ? str(row.hlc) : undefined, op.hlc)) {
          const v = messageValue(op.value);
          this.db.run("INSERT OR REPLACE INTO messages (board_id, id, body, hlc, node_id, to_node, thread) VALUES (?, ?, ?, ?, ?, ?, ?)", [boardId, op.entityId, v.body, op.hlc, op.nodeId, v.to, v.thread]);
        }
        return;
      }
      case "removal": {
        const row = this.db.all("SELECT total FROM removal_counts WHERE board_id = ? AND entity_id = ? AND node_id = ?", [boardId, op.entityId, op.nodeId])[0];
        const total = mergeCounter(row ? num(row.total) : undefined, op.value as number);
        this.db.run("INSERT OR REPLACE INTO removal_counts (board_id, entity_id, node_id, total) VALUES (?, ?, ?, ?)", [boardId, op.entityId, op.nodeId, total]);
        return;
      }
    }
  }

  lastSeq(boardId: string): number {
    return num(this.db.all("SELECT COALESCE(MAX(seq), 0) AS s FROM ops WHERE board_id = ?", [boardId])[0]?.s ?? 0);
  }

  private registers(table: string, boardId: string): { id: string; fields: Record<string, unknown> }[] {
    const rows = this.db.all(`SELECT id, field, value FROM ${table} WHERE board_id = ? ORDER BY id, field`, [boardId]);
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const id = str(r.id);
      const fields = byId.get(id) ?? {};
      fields[str(r.field)] = JSON.parse(str(r.value));
      byId.set(id, fields);
    }
    const out: { id: string; fields: Record<string, unknown> }[] = [];
    for (const [id, fields] of byId) {
      if (isDeleted(fields)) continue;
      const live = { ...fields };
      delete live[DELETED_FIELD];
      out.push({ id, fields: live });
    }
    return out;
  }

  /** Same shape as `merge.viewBoard`, plus the board id and the highest server seq applied. */
  readBoard(boardId: string): BoardRead {
    const messages = orderMessages(
      this.db.all("SELECT id, body, hlc, node_id, to_node, thread FROM messages WHERE board_id = ?", [boardId]).map((r) => ({
        id: str(r.id),
        body: str(r.body),
        hlc: str(r.hlc),
        nodeId: str(r.node_id),
        to: r.to_node === null ? null : str(r.to_node),
        thread: r.thread === null ? null : str(r.thread),
      })),
    );
    const removals: Record<string, number> = {};
    for (const r of this.db.all("SELECT entity_id, SUM(total) AS total FROM removal_counts WHERE board_id = ? GROUP BY entity_id ORDER BY entity_id", [boardId])) {
      removals[str(r.entity_id)] = num(r.total);
    }
    return { id: boardId, lastSeq: this.lastSeq(boardId), missions: this.registers(registerTable("mission"), boardId), notes: this.registers(registerTable("note"), boardId), messages, removals };
  }

  summary(boardId: string): BoardSummary {
    const view = this.readBoard(boardId);
    let removalTotal = 0;
    for (const n of Object.values(view.removals)) removalTotal += n;
    return { boardId, lastSeq: view.lastSeq, missionCount: view.missions.length, removalTotal, messageCount: view.messages.length };
  }

  /** Ops of a board with `seq > afterSeq`, ascending, for peers catching up. */
  opsSince(boardId: string, afterSeq: number): StoredOp[] {
    return this.db.all("SELECT * FROM ops WHERE board_id = ? AND seq > ? ORDER BY seq", [boardId, afterSeq]).map(rowToOp);
  }

  // ---- outbox -----------------------------------------------------------------------------

  enqueue(boardId: string, opIds: readonly string[], nowMs: number): void {
    this.db.transaction(() => {
      for (const id of opIds) {
        this.db.run("INSERT OR IGNORE INTO outbox (op_id, board_id, status, attempts, next_at, created_at) VALUES (?, ?, 'pending', 0, ?, ?)", [id, boardId, nowMs, nowMs]);
      }
    });
  }

  outboxEntries(status?: OutboxStatus): OutboxEntry[] {
    const rows = status
      ? this.db.all("SELECT op_id, board_id, status, attempts, next_at FROM outbox WHERE status = ? ORDER BY next_at, op_id", [status])
      : this.db.all("SELECT op_id, board_id, status, attempts, next_at FROM outbox ORDER BY next_at, op_id");
    return rows.map((r) => ({ opId: str(r.op_id), boardId: str(r.board_id), status: str(r.status) as OutboxStatus, attempts: num(r.attempts), nextAt: num(r.next_at) }));
  }

  /** Entries a flush may send: pending and due, or inflight for too long. */
  outboxDue(nowMs: number): OutboxEntry[] {
    return this.db
      .all("SELECT op_id, board_id, status, attempts, next_at FROM outbox WHERE (status = 'pending' AND next_at <= ?) OR (status = 'inflight' AND next_at <= ?) ORDER BY next_at, op_id", [
        nowMs,
        nowMs - INFLIGHT_STALE_MS,
      ])
      .map((r) => ({ opId: str(r.op_id), boardId: str(r.board_id), status: str(r.status) as OutboxStatus, attempts: num(r.attempts), nextAt: num(r.next_at) }));
  }

  writeOutbox(entries: readonly OutboxEntry[]): void {
    this.db.transaction(() => {
      for (const e of entries) {
        this.db.run("UPDATE outbox SET status = ?, attempts = ?, next_at = ? WHERE op_id = ?", [e.status, e.attempts, e.nextAt, e.opId]);
      }
    });
  }

  /** The ops behind outbox entries, in the entries' order, as the wire `OpInput` needs them. */
  outboxOps(entries: readonly OutboxEntry[]): Op[] {
    const out: Op[] = [];
    for (const e of entries) {
      const row = this.db.all("SELECT * FROM ops WHERE id = ?", [e.opId])[0];
      if (row) out.push(rowToOp(row));
    }
    return out;
  }

  outboxCounts(): Record<OutboxStatus, number> {
    const counts: Record<OutboxStatus, number> = { pending: 0, inflight: 0, acked: 0 };
    for (const r of this.db.all("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status")) counts[str(r.status) as OutboxStatus] = num(r.n);
    return counts;
  }

  /** Acked entries older than `beforeMs` are history; drop them. */
  pruneOutbox(beforeMs: number): void {
    this.db.run("DELETE FROM outbox WHERE status = 'acked' AND created_at < ?", [beforeMs]);
  }
}

function rowToOp(r: Record<string, SqlValue>): StoredOp {
  return {
    id: str(r.id),
    seq: r.seq === null ? 0 : num(r.seq),
    hlc: str(r.hlc),
    boardId: str(r.board_id),
    entity: str(r.entity) as Op["entity"],
    entityId: str(r.entity_id),
    field: str(r.field),
    value: JSON.parse(str(r.value)),
    nodeId: str(r.node_id),
  };
}
