import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyOps, canonical, createState, viewBoard, type BoardState, type BoardView } from "client/threads/crdt/merge";
import type { Op } from "client/threads/crdt/types";

interface Vector {
  name: string;
  board?: string;
  ops: Op[];
  expected: { missions: Record<string, unknown>; notes: Record<string, unknown>; messages: { id: string; body: string; hlc: string; to?: string; thread?: string }[]; removals: Record<string, number> };
}

// apps/web/tests/client/threads/crdt -> repo root -> spec/crdt (../../spec/crdt from apps/web)
const DIR = resolve(import.meta.dir, "../../../../../../spec/crdt");
const vectors: Vector[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(resolve(DIR, f), "utf8")) as Vector);

const targetBoard = (v: Vector) => v.board ?? v.ops[0]?.boardId ?? "b1";

/** Apply ops board by board, in delivery order within each board. */
function applyGrouped(ops: readonly Op[]): Map<string, BoardState> {
  const boards = new Map<string, BoardState>();
  const grouped = new Map<string, Op[]>();
  for (const op of ops) {
    const b = op.boardId ?? "b1";
    const list = grouped.get(b) ?? [];
    list.push(op);
    grouped.set(b, list);
  }
  for (const [b, list] of grouped) boards.set(b, applyOps(createState(b), list));
  return boards;
}

function projection(view: BoardView) {
  const map = (xs: { id: string; fields: Record<string, unknown> }[]) => Object.fromEntries(xs.map((e) => [e.id, e.fields]));
  return {
    missions: map(view.missions),
    notes: map(view.notes),
    messages: view.messages.map(({ id, body, hlc, to, thread }) => ({ id, body, hlc, ...(to === null ? {} : { to }), ...(thread === null ? {} : { thread }) })),
    removals: view.removals,
  };
}

/** xorshift32, fixed seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function shuffle<T>(xs: T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("CRDT golden vectors", () => {
  test("at least 12 vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(12);
  });

  test("every vector materializes to its expected board", () => {
    let passed = 0;
    const failures: string[] = [];
    for (const v of vectors) {
      const boards = applyGrouped(v.ops);
      const got = projection(viewBoard(boards.get(targetBoard(v)) ?? createState(targetBoard(v))));
      if (Bun.deepEquals(got, v.expected, true)) passed++;
      else failures.push(`${v.name}\n  expected ${JSON.stringify(v.expected)}\n  got      ${JSON.stringify(got)}`);
    }
    console.log(`CRDT vectors passed: ${passed}/${vectors.length}`);
    expect(failures).toEqual([]);
  });

  test("converges under 200 random permutations per vector", () => {
    const next = rng(0x9e3779b9);
    let runs = 0;
    for (const v of vectors) {
      const baseline = new Map([...applyGrouped(v.ops)].map(([b, s]) => [b, canonical(s)]));
      for (let round = 0; round < 200; round++) {
        const shuffled = shuffle(v.ops, next);
        const got = new Map([...applyGrouped(shuffled)].map(([b, s]) => [b, canonical(s)]));
        if (!Bun.deepEquals(got, baseline)) throw new Error(`${v.name} diverged on permutation ${round}`);
        runs++;
      }
    }
    console.log(`CRDT permutations converged: ${runs} (200 per vector)`);
    expect(runs).toBe(vectors.length * 200);
  });

  test("applyOps is pure and idempotent", () => {
    const v = vectors.find((x) => x.name === "duplicate-delivery")!;
    const empty = createState("b1");
    const once = applyOps(empty, v.ops);
    const twice = applyOps(once, v.ops);
    expect(empty.seen.size).toBe(0);
    expect(canonical(twice)).toBe(canonical(once));
    expect(once.seen.size).toBe(new Set(v.ops.map((o) => o.id)).size);
  });

  test("invalid ops reject the whole batch", () => {
    const good: Op = { id: "op-1", hlc: "1700000000000:0:a", boardId: "b1", entity: "mission", entityId: "m1", field: "title", value: "x", nodeId: "a" };
    const state = createState("b1");
    const bad: [string, Partial<Op>][] = [
      ["entity", { entity: "task" as Op["entity"] }],
      ["field", { field: "" }],
      ["value size", { value: "x".repeat(16 * 1024) }],
      ["hlc", { hlc: "1700:x:a" }],
      ["hlc node", { hlc: "1700:0:" }],
      ["board", { boardId: "b2" }],
      ["message field", { entity: "message", field: "title" }],
      ["message body", { entity: "message", field: "body", value: 1 }],
      ["removal value", { entity: "removal", value: -1 }],
      ["removal float", { entity: "removal", value: 1.5 }],
      ["removal huge", { entity: "removal", value: Number.MAX_SAFE_INTEGER + 2 }],
      ["hlc 16 digits", { hlc: "1700000000000000:0:a" }],
      ["bigint value", { value: 1n as unknown }],
      ["_deleted", { field: "_deleted", value: "yes" }],
      ["message object body", { entity: "message", field: "body", value: { body: 1 } }],
      ["message extra key", { entity: "message", field: "body", value: { body: "x", html: "y" } }],
      ["message empty to", { entity: "message", field: "body", value: { body: "x", to: "" } }],
      ["message array", { entity: "message", field: "body", value: ["x"] }],
      ["id", { id: "" }],
    ];
    for (const [label, patch] of bad) {
      expect(() => applyOps(state, [good, { ...good, id: "op-2", ...patch }]), label).toThrow();
    }
    expect(applyOps(state, [good]).seen.size).toBe(1);
    expect(applyOps(state, [{ ...good, value: "x".repeat(16 * 1024 - 2) }]).seen.size).toBe(1);
  });
});
