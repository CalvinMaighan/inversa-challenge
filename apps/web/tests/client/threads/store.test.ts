import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyOps as applyPure, createState, viewBoard } from "client/threads/crdt/merge";
import type { Op, StoredOp } from "client/threads/crdt/types";
import { SCHEMA_STATEMENTS } from "client/threads/db/schema";

import { openTestStore } from "./sqlite-fixture";

interface Vector {
  name: string;
  board?: string;
  ops: Op[];
  expected: { missions: Record<string, unknown>; notes: Record<string, unknown>; messages: { id: string; body: string; hlc: string }[]; removals: Record<string, number> };
}

const DIR = resolve(import.meta.dir, "../../../../../spec/crdt");
const vectors: Vector[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(resolve(DIR, f), "utf8")) as Vector);

const op = (id: string, over: Partial<Op> = {}): Op => ({ id, hlc: `1700000000000:0:n`, boardId: "b1", entity: "mission", entityId: "m1", field: "title", value: "x", nodeId: "n", ...over });

describe("schema", () => {
  test("migrates idempotently and creates the eight tables", () => {
    const store = openTestStore();
    store.migrate();
    const tables = store.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(["cache_frames", "cache_queries", "messages", "meta", "missions", "notes", "ops", "outbox", "removal_counts"]);
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(8);
  });
});

describe("CRDT tables against spec/crdt vectors", () => {
  expect(vectors.length).toBeGreaterThan(5);
  for (const v of vectors) {
    test(v.name, () => {
      const store = openTestStore();
      const boards = new Map<string, Op[]>();
      for (const o of v.ops) boards.set(o.boardId ?? "b1", [...(boards.get(o.boardId ?? "b1") ?? []), o]);
      for (const [b, ops] of boards) store.applyOps(b, ops, 1);
      const board = v.board ?? v.ops[0]?.boardId ?? "b1";
      const view = store.readBoard(board);
      const asMap = (xs: { id: string; fields: Record<string, unknown> }[]): Record<string, unknown> => Object.fromEntries(xs.map((e) => [e.id, e.fields]));
      expect(asMap(view.missions)).toEqual(v.expected.missions);
      expect(asMap(view.notes)).toEqual(v.expected.notes);
      expect(view.messages.map((m) => ({ id: m.id, body: m.body, hlc: m.hlc }))).toEqual(v.expected.messages);
      expect(view.removals).toEqual(v.expected.removals);
      // And the SQL view matches T12's pure view for the same delivery order.
      const pure = viewBoard(applyPure(createState(board), boards.get(board) ?? []));
      expect({ missions: view.missions, notes: view.notes, messages: view.messages, removals: view.removals }).toEqual(pure);
    });
  }

  test("converges under a different delivery order", () => {
    const v = vectors.find((x) => x.name === "out-of-order") ?? vectors[0]!;
    const board = v.board ?? v.ops[0]?.boardId ?? "b1";
    const forward = openTestStore();
    forward.applyOps(board, v.ops, 1);
    const reversed = openTestStore();
    for (const o of [...v.ops].reverse()) reversed.applyOps(board, [o], 1);
    const strip = (s: ReturnType<typeof forward.readBoard>) => ({ missions: s.missions, notes: s.notes, messages: s.messages, removals: s.removals });
    expect(strip(reversed.readBoard(board))).toEqual(strip(forward.readBoard(board)));
  });
});

describe("ops, seq and outbox", () => {
  test("apply is idempotent, reports duplicates, and a server echo confirms our seq", () => {
    const store = openTestStore();
    const first = store.applyOps("b1", [op("a"), op("b", { entityId: "m2" })], 10);
    expect(first).toEqual({ applied: 2, duplicates: 0, appliedIds: ["a", "b"], confirmed: [], maxSeq: null });
    expect(store.lastSeq("b1")).toBe(0);
    const echo: StoredOp[] = [{ ...op("a"), seq: 7 }, { ...op("c", { entityId: "m3" }), seq: 8 }];
    const second = store.applyOps("b1", echo, 11);
    expect(second).toEqual({ applied: 1, duplicates: 1, appliedIds: ["c"], confirmed: ["a"], maxSeq: 8 });
    expect(store.lastSeq("b1")).toBe(8);
    expect(store.opsSince("b1", 7).map((o) => o.id)).toEqual(["c"]);
    expect(store.hasOp("b")).toBe(true);
  });

  test("an invalid op rejects the whole batch", () => {
    const store = openTestStore();
    expect(() => store.applyOps("b1", [op("ok"), op("bad", { entity: "removal", value: -1 })], 1)).toThrow(/invalid op bad/);
    expect(store.hasOp("ok")).toBe(false);
    expect(() => store.applyOps("b1", [op("wrong-board", { boardId: "b2" })], 1)).toThrow(/does not match/);
  });

  test("outbox lifecycle through the tables", () => {
    const store = openTestStore();
    store.applyOps("b1", [op("a"), op("b", { entityId: "m2" })], 100);
    store.enqueue("b1", ["a", "b"], 100);
    store.enqueue("b1", ["a"], 200); // second enqueue is ignored
    expect(store.outboxCounts()).toEqual({ pending: 2, inflight: 0, acked: 0 });
    const due = store.outboxDue(100);
    expect(due.map((e) => e.opId)).toEqual(["a", "b"]);
    expect(store.outboxOps(due).map((o) => o.id)).toEqual(["a", "b"]);
    store.writeOutbox(due.map((e) => ({ ...e, status: "inflight" as const, attempts: 1, nextAt: 150 })));
    expect(store.outboxDue(160)).toEqual([]);
    store.writeOutbox([{ ...due[0]!, status: "acked", attempts: 1, nextAt: 150 }, { ...due[1]!, status: "pending", attempts: 1, nextAt: 5_000 }]);
    expect(store.outboxCounts()).toEqual({ pending: 1, inflight: 0, acked: 1 });
    expect(store.outboxDue(4_999)).toEqual([]);
    expect(store.outboxDue(5_000).map((e) => e.opId)).toEqual(["b"]);
    store.pruneOutbox(101);
    expect(store.outboxEntries().map((e) => e.opId)).toEqual(["b"]);
  });

  test("summary counts live missions and sums removal counters", () => {
    const store = openTestStore();
    store.applyOps(
      "b1",
      [
        op("1", { entityId: "m1" }),
        op("2", { entityId: "m2" }),
        op("3", { entityId: "m2", field: "_deleted", value: true, hlc: "1700000000001:0:n" }),
        op("4", { entity: "removal", entityId: "m1", field: "count", value: 3, nodeId: "a", hlc: "1700000000001:0:a" }),
        op("5", { entity: "removal", entityId: "m1", field: "count", value: 2, nodeId: "b", hlc: "1700000000001:0:b" }),
        op("6", { entity: "message", entityId: "msg1", field: "body", value: "hi", hlc: "1700000000002:0:n" }),
      ],
      1,
    );
    expect(store.summary("b1")).toEqual({ boardId: "b1", lastSeq: 0, missionCount: 1, removalTotal: 5, messageCount: 1 });
  });
});

describe("caches", () => {
  test("cache_queries rows decide fresh, stale and miss, and prune", () => {
    const store = openTestStore();
    expect(store.decide("h", 1000)).toEqual({ decision: "miss", row: null });
    store.putCached("h", '{"data":1}', 1000, 500);
    expect(store.decide("h", 1400).decision).toBe("fresh");
    expect(store.decide("h", 1600).decision).toBe("stale");
    expect(store.getCached("h")).toEqual({ hash: "h", json: '{"data":1}', fetchedAt: 1000, ttlMs: 500 });
    expect(store.cachedCount()).toBe(1);
    expect(store.pruneCache(1000 + 500 + 100, 50)).toBe(1);
    expect(store.cachedCount()).toBe(0);
  });

  test("cache_frames rows come back by step and range, keep blobs intact, and prune", () => {
    const store = openTestStore();
    const body = new Uint8Array([1, 2, 3, 250]);
    store.putFrames([
      { frameAt: 100, step: 60, etag: "e1", body, fetchedAt: 1 },
      { frameAt: 160, step: 60, etag: "e1", body, fetchedAt: 1 },
      { frameAt: 115, step: 15, etag: "e2", body: new Uint8Array([9]), fetchedAt: 1 },
    ]);
    const rows = store.getFrames(0, 200, 60);
    expect(rows.map((r) => r.frameAt)).toEqual([100, 160]);
    expect(Array.from(rows[0]!.body)).toEqual([1, 2, 3, 250]);
    expect(store.frameTimes(0, 200, 15)).toEqual(new Set([115]));
    expect(store.rangeEtag(0, 200, 60)).toBe("e1");
    store.putFrames([{ frameAt: 160, step: 60, etag: "e3", body, fetchedAt: 2 }]);
    expect(store.rangeEtag(0, 200, 60)).toBeNull();
    expect(store.frameCount()).toBe(3);
    store.pruneFrames(150);
    expect(store.frameCount()).toBe(1);
  });
});
