import { describe, expect, test } from "bun:test";

import {
  ackByIds,
  dueEntries,
  INFLIGHT_STALE_MS,
  markInflight,
  MAX_BATCH,
  MAX_RETRY_MS,
  pendingCount,
  reconcileFlush,
  retryDelayMs,
  type OutboxEntry,
} from "client/threads/db/outbox";

const entry = (opId: string, over: Partial<OutboxEntry> = {}): OutboxEntry => ({ opId, boardId: "b1", status: "pending", attempts: 0, nextAt: 0, ...over });

describe("outbox", () => {
  test("retry delay doubles from 1 s and caps at a minute", () => {
    expect(retryDelayMs(0)).toBe(1_000);
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(3)).toBe(4_000);
    expect(retryDelayMs(20)).toBe(MAX_RETRY_MS);
  });

  test("due picks pending entries whose time has come, one board per batch, oldest first", () => {
    const entries = [
      entry("late", { nextAt: 5_000 }),
      entry("b", { nextAt: 100 }),
      entry("a", { nextAt: 100 }),
      entry("other-board", { boardId: "b2", nextAt: 50 }),
      entry("done", { status: "acked" }),
    ];
    const due = dueEntries(entries, 1_000);
    expect(due.map((e) => e.opId)).toEqual(["other-board"]);
    const rest = dueEntries(entries.filter((e) => e.boardId === "b1"), 1_000);
    expect(rest.map((e) => e.opId)).toEqual(["a", "b"]);
  });

  test("inflight entries count as due again after the stale bound (a leader died mid-flush)", () => {
    const stuck = entry("x", { status: "inflight", nextAt: 0, attempts: 1 });
    expect(dueEntries([stuck], INFLIGHT_STALE_MS - 1)).toEqual([]);
    expect(dueEntries([stuck], INFLIGHT_STALE_MS)).toEqual([stuck]);
  });

  test("due caps a batch", () => {
    const many = Array.from({ length: MAX_BATCH + 10 }, (_, i) => entry(`op-${String(i).padStart(4, "0")}`));
    expect(dueEntries(many, 1)).toHaveLength(MAX_BATCH);
  });

  test("markInflight bumps attempts and stamps the send time", () => {
    const [m] = markInflight([entry("a", { attempts: 2 })], 777);
    expect(m).toEqual(entry("a", { status: "inflight", attempts: 3, nextAt: 777 }));
  });

  test("a successful applyOps acks every op it covered, duplicates included", () => {
    const sent = markInflight([entry("a"), entry("b")], 10);
    const out = reconcileFlush(sent, { applied: 1, duplicates: 1, lastSeq: 9 }, 20);
    expect(out.acked.map((e) => e.status)).toEqual(["acked", "acked"]);
    expect(out.retry).toEqual([]);
  });

  test("a short count or an error retries the whole batch with backoff", () => {
    const sent = markInflight([entry("a"), entry("b", { attempts: 2 })], 10);
    const short = reconcileFlush(sent, { applied: 1, duplicates: 0, lastSeq: 9 }, 100);
    expect(short.acked).toEqual([]);
    expect(short.retry.map((e) => [e.status, e.attempts, e.nextAt])).toEqual([
      ["pending", 1, 100 + 1_000],
      ["pending", 3, 100 + 4_000],
    ]);
    const failed = reconcileFlush(sent, new Error("offline"), 100);
    expect(failed.retry).toHaveLength(2);
  });

  test("ackByIds settles only known, unacked ids", () => {
    const entries = [entry("a"), entry("b", { status: "inflight" }), entry("c", { status: "acked" })];
    const acked = ackByIds(entries, ["a", "b", "c", "unknown"]);
    expect(acked.map((e) => e.opId)).toEqual(["a", "b"]);
    expect(acked.every((e) => e.status === "acked")).toBe(true);
    expect(pendingCount(entries)).toBe(2);
  });
});
