/**
 * Outbox reconciliation (PRD §12 "New tech 2", write path step 4). Pure over row snapshots: the db worker
 * reads `outbox` rows, runs these, and writes the result back.
 *
 * Life of an entry: `pending` -> `inflight` (sent in an `applyOps` batch) -> `acked`, or back to `pending`
 * with a later `nextAt` when the batch failed. An op seen coming back from the server (subscription or
 * `opsSince`) is acked by id whatever its state.
 */

export type OutboxStatus = "pending" | "inflight" | "acked";

export type OutboxEntry = {
  opId: string;
  boardId: string;
  status: OutboxStatus;
  attempts: number;
  /** Unix ms; a pending entry is due once `nextAt <= now`. */
  nextAt: number;
};

/** Mirrors `ApplyResult` in api/schema.graphql. */
export type ApplyResult = { applied: number; duplicates: number; lastSeq: number };

export const MAX_BATCH = 200;
const BASE_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 60_000;
/** An entry stuck `inflight` longer than this (leader died mid-flush) is due again. */
export const INFLIGHT_STALE_MS = 30_000;

/** 1 s, 2 s, 4 s ... capped at a minute. */
export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

/** Entries to send now, oldest first, one board per batch. */
export function dueEntries(entries: readonly OutboxEntry[], nowMs: number, limit = MAX_BATCH): OutboxEntry[] {
  const due = entries.filter(
    (e) => (e.status === "pending" && e.nextAt <= nowMs) || (e.status === "inflight" && nowMs - e.nextAt >= INFLIGHT_STALE_MS),
  );
  due.sort((a, b) => a.nextAt - b.nextAt || (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0));
  const board = due[0]?.boardId;
  return board === undefined ? [] : due.filter((e) => e.boardId === board).slice(0, limit);
}

export function markInflight(entries: readonly OutboxEntry[], nowMs: number): OutboxEntry[] {
  return entries.map((e) => ({ ...e, status: "inflight", attempts: e.attempts + 1, nextAt: nowMs }));
}

export type FlushOutcome = { acked: OutboxEntry[]; retry: OutboxEntry[] };

/**
 * Settle a batch after `applyOps`. A successful mutation covers every op it was given: the server either
 * applied it or already had it (`duplicates`). A short count means the server dropped part of the batch, so
 * the whole batch retries; apply is idempotent on id, so re-sending is safe.
 */
export function reconcileFlush(sent: readonly OutboxEntry[], result: ApplyResult | Error, nowMs: number): FlushOutcome {
  const ok = !(result instanceof Error) && result.applied + result.duplicates >= sent.length;
  if (ok) return { acked: sent.map((e) => ({ ...e, status: "acked" })), retry: [] };
  return {
    acked: [],
    retry: sent.map((e) => ({ ...e, status: "pending", nextAt: nowMs + retryDelayMs(e.attempts) })),
  };
}

/** Ack by op id: the server echoed these ops back, so it has them. Unknown ids are ignored. */
export function ackByIds(entries: readonly OutboxEntry[], ids: Iterable<string>): OutboxEntry[] {
  const set = new Set(ids);
  return entries.filter((e) => set.has(e.opId) && e.status !== "acked").map((e) => ({ ...e, status: "acked" }));
}

export function pendingCount(entries: readonly OutboxEntry[]): number {
  return entries.filter((e) => e.status !== "acked").length;
}
