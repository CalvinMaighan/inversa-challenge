/**
 * Double delivery: a peer's op arrives over the data channel first and again from the server's `ops`
 * subscription (with a seq). Both engines run the real Store over bun:sqlite.
 */
import { describe, expect, test } from "bun:test";

import type { Op, StoredOp } from "client/threads/crdt/types";
import { DbEngine, type EngineGql } from "client/threads/db/engine";
import type { DbEvent } from "client/threads/db/rpc";
import type { GqlResult, GqlVariables, Sink } from "client/threads/gql/protocol";

import { openTestStore } from "../sqlite-fixture";

const BOARD = "everglades";

/** A tiny Axum: assigns seqs, answers applyOps and opsSince, fans out to `ops` subscribers. */
class FakeServer {
  readonly log: StoredOp[] = [];
  readonly sinks = new Set<Sink>();
  seen = new Set<string>();

  apply(ops: Op[]): { applied: number; duplicates: number; lastSeq: number } {
    let applied = 0;
    let duplicates = 0;
    for (const op of ops) {
      if (this.seen.has(op.id)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(op.id);
      const stored: StoredOp = { ...op, boardId: BOARD, seq: this.log.length + 1 };
      this.log.push(stored);
      applied += 1;
      for (const s of this.sinks) s.next({ ops: stored });
    }
    return { applied, duplicates, lastSeq: this.log.length };
  }

  gql(): EngineGql & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      socket: "open",
      request: async (query: string, variables: GqlVariables): Promise<GqlResult> => {
        calls.push(query.split("(")[0]!.trim());
        if (/applyOps/.test(query)) return { data: { applyOps: this.apply(variables.ops as Op[]) } };
        if (/opsSince/.test(query)) return { data: { opsSince: this.log.filter((o) => o.seq > (variables.seq as number)) } };
        return { errors: [{ message: `unhandled ${query}` }] };
      },
      subscribe: (_q, _v, sink) => {
        this.sinks.add(sink);
        return () => this.sinks.delete(sink);
      },
    };
  }
}

function engine(gql: EngineGql, now: () => number) {
  const events: DbEvent[] = [];
  const timers: (() => void)[] = [];
  const e = new DbEngine({
    store: openTestStore(),
    gql,
    fetchImpl: () => Promise.reject(new Error("no fetch")),
    framesUrl: "/v1/frames",
    shared: false,
    opfs: false,
    now,
    post: (ev) => events.push(ev),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
  });
  return { e, events, flushTimers: async () => Promise.all(timers.splice(0).map((fn) => fn())) };
}

const op = (id: string, nodeId: string, hlc: string, over: Partial<Op> = {}): Op => ({ id, hlc, boardId: BOARD, entity: "mission", entityId: "m1", field: "status", value: "planned", nodeId, ...over });

describe("outbox reconciliation after rtc and ws double delivery", () => {
  test("B applies A's ops once, counts the ws copy as duplicates, and both boards converge; A's outbox acks on echo", async () => {
    let t = 1_000;
    const now = () => t;
    const server = new FakeServer();
    const A = engine(server.gql(), now);
    const B = engine(server.gql(), now);
    await A.e.syncBoard({ boardId: BOARD });
    await B.e.syncBoard({ boardId: BOARD });

    // 1-2. A edits: local apply, outbox pending, and (via the rtc worker) the same ops reach B unsequenced.
    const ops = [op("op-1", "A", "2000:0:A", { field: "title", value: "Sweep 12" }), op("op-2", "A", "2000:1:A", { value: "in_progress" })];
    const local = A.e.applyLocalOps({ boardId: BOARD, ops });
    expect(local).toMatchObject({ applied: 2, duplicates: 0, pending: 2 });
    const viaRtc = B.e.applyRemoteOps({ boardId: BOARD, ops });
    expect(viaRtc).toMatchObject({ applied: 2, duplicates: 0, confirmed: [], maxSeq: null });
    expect(B.e.readBoard({ boardId: BOARD }).missions).toEqual([{ id: "m1", fields: { title: "Sweep 12", status: "in_progress" } }]);

    // 4-5. A's outbox flushes to applyOps; the server fans the sequenced ops out to both subscriptions.
    t += 100;
    await A.flushTimers();
    expect(server.log.map((o) => o.id)).toEqual(["op-1", "op-2"]);
    // B saw the ws copy: duplicates, no new apply, seqs recorded, board unchanged.
    expect(B.e.store.opsSince(BOARD, 0).map((o) => [o.id, o.seq])).toEqual([
      ["op-1", 1],
      ["op-2", 2],
    ]);
    expect(B.e.store.lastSeq(BOARD)).toBe(2);
    expect(B.e.stats().outbox).toEqual({ pending: 0, inflight: 0, acked: 0 }); // remote ops never enter B's outbox
    // A's own echo confirmed its rows and acked the outbox entries.
    expect(A.e.stats().outbox).toEqual({ pending: 0, inflight: 0, acked: 2 });
    expect(A.e.store.lastSeq(BOARD)).toBe(2);
    expect(A.e.readBoard({ boardId: BOARD })).toEqual(B.e.readBoard({ boardId: BOARD }));

    // The order can also flip: the ws copy lands before a slow data channel. Still one apply.
    const late = op("op-3", "A", "2001:0:A", { value: "done" });
    A.e.applyLocalOps({ boardId: BOARD, ops: [late] });
    await A.flushTimers();
    expect(B.e.store.lastSeq(BOARD)).toBe(3);
    // Board events so far: the rtc batch, one confirmation per sequenced echo (op-1, op-2), the ws-first op-3.
    const boardEvents = () => B.events.filter((e) => e.t === "db:board").length;
    expect(boardEvents()).toBe(4);
    const viaRtcLate = B.e.applyRemoteOps({ boardId: BOARD, ops: [late] });
    expect(viaRtcLate).toMatchObject({ applied: 0, duplicates: 1, confirmed: [] });
    expect(B.e.readBoard({ boardId: BOARD }).missions[0]!.fields.status).toBe("done");
    expect(boardEvents()).toBe(4); // the late duplicate changed nothing and fired nothing
  });

  test("an op that reaches B over rtc while B's socket is down is acked to the server later without a second apply", async () => {
    let t = 1_000;
    const now = () => t;
    const server = new FakeServer();
    const A = engine(server.gql(), now);
    const B = engine(server.gql(), now);
    await A.e.syncBoard({ boardId: BOARD });
    // B: subscription never established (socket down): only rtc reaches it.
    const ops = [op("r-1", "A", "3000:0:A", { entity: "removal", entityId: "m1", field: "count", value: 3 })];
    A.e.applyLocalOps({ boardId: BOARD, ops });
    B.e.applyRemoteOps({ boardId: BOARD, ops });
    t += 100;
    await A.flushTimers();
    expect(B.e.store.lastSeq(BOARD)).toBe(0);
    // Reconnect: opsSince(0) returns the sequenced copy; B records the seq, applies nothing new.
    const sync = await B.e.syncBoard({ boardId: BOARD });
    expect(sync).toEqual({ lastSeq: 1, pulled: 0, subscribed: true });
    expect(B.e.readBoard({ boardId: BOARD }).removals).toEqual({ m1: 3 });
    expect(A.e.readBoard({ boardId: BOARD })).toEqual(B.e.readBoard({ boardId: BOARD }));
  });

  test("concurrent removal counters from two nodes sum, whichever copies arrive first or twice", async () => {
    const server = new FakeServer();
    const A = engine(server.gql(), () => 1);
    const B = engine(server.gql(), () => 1);
    await A.e.syncBoard({ boardId: BOARD });
    await B.e.syncBoard({ boardId: BOARD });
    const a2 = op("a-2", "A", "5000:0:A", { entity: "removal", field: "count", value: 2 });
    const b3 = op("b-3", "B", "5000:0:B", { entity: "removal", field: "count", value: 3 });
    A.e.applyLocalOps({ boardId: BOARD, ops: [a2] });
    B.e.applyLocalOps({ boardId: BOARD, ops: [b3] });
    B.e.applyRemoteOps({ boardId: BOARD, ops: [a2] });
    A.e.applyRemoteOps({ boardId: BOARD, ops: [b3] });
    await A.flushTimers();
    await B.flushTimers();
    // Every copy delivered to both (ws fan-out) on top of the rtc copies.
    expect(A.e.readBoard({ boardId: BOARD }).removals).toEqual({ m1: 5 });
    expect(B.e.readBoard({ boardId: BOARD }).removals).toEqual({ m1: 5 });
    expect(A.e.stats().outbox.acked).toBe(1);
    expect(B.e.stats().outbox.acked).toBe(1);
  });
});
