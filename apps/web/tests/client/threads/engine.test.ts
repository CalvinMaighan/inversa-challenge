import { describe, expect, test } from "bun:test";

import type { Op, StoredOp } from "client/threads/crdt/types";
import { DbEngine, type EngineGql } from "client/threads/db/engine";
import { attachGrid, frameAxis } from "client/threads/db/frames";
import type { DbEvent } from "client/threads/db/rpc";
import { totalSightings, unpackSightings } from "client/threads/db/sightings";
import type { GqlResult, GqlVariables, Sink } from "client/threads/gql/protocol";

import { encodeEvf2, hotspotValue, sightingId } from "./evf-fixture";
import { openTestStore } from "./sqlite-fixture";

type Call = { query: string; variables: GqlVariables };

function fakeGql(answer: (c: Call) => GqlResult | Promise<GqlResult>): EngineGql & { calls: Call[]; sinks: Map<string, Sink> } {
  const calls: Call[] = [];
  const sinks = new Map<string, Sink>();
  return {
    calls,
    sinks,
    socket: "open",
    async request(query, variables) {
      const c = { query, variables };
      calls.push(c);
      return answer(c);
    },
    subscribe(query, _variables, sink) {
      sinks.set(query, sink);
      return () => sinks.delete(query);
    },
  };
}

const H = 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

function makeEngine(over: { gql?: EngineGql | null; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; shared?: boolean; now?: () => number } = {}) {
  const events: DbEvent[] = [];
  const transfers: Transferable[][] = [];
  const summaries: unknown[] = [];
  const timers: (() => void)[] = [];
  const engine = new DbEngine({
    store: openTestStore(),
    gql: over.gql === undefined ? fakeGql(() => ({ data: null })) : over.gql,
    fetchImpl: over.fetchImpl ?? (() => Promise.reject(new Error("no fetch"))),
    framesUrl: "/v1/frames",
    shared: over.shared ?? true,
    opfs: false,
    now: over.now ?? (() => 1_000_000),
    post: (e, t) => {
      events.push(e);
      transfers.push(t ?? []);
    },
    onSummary: (s) => summaries.push(s),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
  });
  return {
    engine,
    events,
    transfers,
    summaries,
    timers,
    runTimers: async () => {
      const t = timers.splice(0);
      for (const fn of t) await fn();
    },
  };
}

const op = (id: string, over: Partial<Op> = {}): Op => ({ id, hlc: `1700000000000:0:me`, boardId: "b1", entity: "mission", entityId: "m1", field: "title", value: "x", nodeId: "me", ...over });

describe("query: stale-while-revalidate", () => {
  const FEEDS = "{ feeds { source } }";

  test("miss fetches and caches; a fresh hit never touches the network", async () => {
    let now = 1_000;
    const gql = fakeGql(() => ({ data: { feeds: [{ source: "nws" }] } }));
    const { engine } = makeEngine({ gql, now: () => now });
    const first = await engine.query({ query: FEEDS });
    expect(first).toEqual({ data: { feeds: [{ source: "nws" }] }, source: "network" });
    expect(gql.calls).toHaveLength(1);
    now += 10_000; // feeds ttl is 30 s
    const second = await engine.query({ query: FEEDS, variables: {} });
    expect(second).toEqual({ data: { feeds: [{ source: "nws" }] }, source: "cache" });
    expect(gql.calls).toHaveLength(1);
    expect(engine.stats().lastQuerySource).toBe("cache");
  });

  test("stale answers immediately from the cache, then revalidates in the background", async () => {
    let now = 1_000;
    let version = 1;
    const gql = fakeGql(() => ({ data: { feeds: [{ source: `v${version}` }] } }));
    const { engine } = makeEngine({ gql, now: () => now });
    await engine.query({ query: FEEDS });
    now += 31_000;
    version = 2;
    const stale = await engine.query({ query: FEEDS });
    expect(stale.source).toBe("stale");
    expect(stale.data).toEqual({ feeds: [{ source: "v1" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(gql.calls).toHaveLength(2);
    const after = await engine.query({ query: FEEDS });
    expect(after).toEqual({ data: { feeds: [{ source: "v2" }] }, source: "cache" });
  });

  test("a network failure falls back to an old row; without one the error comes through", async () => {
    let now = 1_000;
    let online = true;
    const gql = fakeGql(() => (online ? { data: { feeds: [] } } : { errors: [{ message: "offline", extensions: { network: true } }], status: 0 }));
    const { engine } = makeEngine({ gql, now: () => now });
    await engine.query({ query: FEEDS });
    online = false;
    now += 25 * H; // past MAX_STALE_MS: a miss, network first
    const fallback = await engine.query({ query: FEEDS });
    expect(fallback).toEqual({ data: { feeds: [] }, source: "fallback" });
    const none = await engine.query({ query: '{ alerts(bbox: {west: 0, south: 0, east: 1, north: 1}, at: "x") { id } }' });
    expect(none.source).toBe("network");
    expect(none.errors?.[0]?.message).toBe("offline");
  });

  test("mutations and uncacheable roots bypass the cache; an unlinked gql worker reports it", async () => {
    const gql = fakeGql(() => ({ data: { applyOps: { applied: 1, duplicates: 0, lastSeq: 1 } } }));
    const { engine } = makeEngine({ gql });
    const m = 'mutation { applyOps(boardId: "b", ops: []) { applied } }';
    await engine.query({ query: m });
    await engine.query({ query: m });
    expect(gql.calls).toHaveLength(2);
    expect(engine.store.cachedCount()).toBe(0);
    const unlinked = makeEngine({ gql: null }).engine;
    const res = await unlinked.query({ query: FEEDS });
    expect(res.errors?.[0]?.message).toMatch(/not linked/);
  });
});

describe("CRDT and outbox", () => {
  test("applyLocalOps applies optimistically, enqueues, reports the board and schedules a flush that acks", async () => {
    const gql = fakeGql(({ query }) => (query.includes("applyOps") ? { data: { applyOps: { applied: 2, duplicates: 0, lastSeq: 12 } } } : { data: null }));
    const { engine, events, summaries, runTimers } = makeEngine({ gql });
    const res = engine.applyLocalOps({ boardId: "b1", ops: [op("a"), op("b", { entityId: "m2", value: "y" })] });
    expect(res).toEqual({ applied: 2, duplicates: 0, lastSeq: 0, pending: 2 });
    expect(engine.readBoard({ boardId: "b1" }).missions.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(events).toEqual([{ t: "db:board", boardId: "b1" }]);
    expect(summaries).toEqual([{ boardId: "b1", lastSeq: 0, missionCount: 2, removalTotal: 0, messageCount: 0 }]);
    await runTimers();
    const sent = gql.calls.find((c) => c.query.includes("applyOps"));
    expect(sent?.variables).toEqual({
      boardId: "b1",
      ops: [
        { id: "a", hlc: "1700000000000:0:me", entity: "mission", entityId: "m1", field: "title", value: "x", nodeId: "me" },
        { id: "b", hlc: "1700000000000:0:me", entity: "mission", entityId: "m2", field: "title", value: "y", nodeId: "me" },
      ],
    });
    expect(engine.store.outboxCounts()).toEqual({ pending: 0, inflight: 0, acked: 2 });
  });

  test("a failed flush retries later with backoff; the echo from the server acks by id", async () => {
    let now = 1_000;
    let up = false;
    const gql = fakeGql(() => (up ? { data: { applyOps: { applied: 1, duplicates: 0, lastSeq: 3 } } } : { errors: [{ message: "503" }] }));
    const { engine } = makeEngine({ gql, now: () => now });
    engine.applyLocalOps({ boardId: "b1", ops: [op("a")] });
    expect(await engine.flushOutbox({})).toEqual({ sent: 1, acked: 0, retried: 1 });
    expect(engine.store.outboxEntries()[0]).toMatchObject({ status: "pending", attempts: 1, nextAt: 2_000 });
    expect(await engine.flushOutbox({})).toEqual({ sent: 0, acked: 0, retried: 0 }); // not due yet
    now = 2_000;
    up = true;
    expect(await engine.flushOutbox({})).toEqual({ sent: 1, acked: 1, retried: 0 });

    engine.applyLocalOps({ boardId: "b1", ops: [op("c", { entityId: "m9" })] });
    const echo: StoredOp = { ...op("c", { entityId: "m9" }), seq: 4 };
    const remote = engine.applyRemoteOps({ boardId: "b1", ops: [echo] });
    expect(remote).toMatchObject({ applied: 0, duplicates: 1, confirmed: ["c"], maxSeq: 4, lastSeq: 4 });
    expect(engine.store.outboxEntries().find((e) => e.opId === "c")?.status).toBe("acked");
  });

  test("syncBoard pulls opsSince, subscribes to ops, and applies what arrives", async () => {
    const gql = fakeGql(({ query }) => {
      if (query.includes("opsSince")) return { data: { opsSince: [{ ...op("r1", { entityId: "mx", nodeId: "peer", hlc: "1700000000005:0:peer" }), seq: 5 }] } };
      return { data: { applyOps: { applied: 0, duplicates: 0, lastSeq: 5 } } };
    });
    const { engine, events } = makeEngine({ gql });
    const res = await engine.syncBoard({ boardId: "b1" });
    expect(res).toEqual({ lastSeq: 5, pulled: 1, subscribed: true });
    expect(gql.calls[0]?.variables).toEqual({ boardId: "b1", seq: 0 });
    const sub = [...gql.sinks.entries()].find(([q]) => q.includes("subscription"))?.[1];
    expect(sub).toBeDefined();
    sub!.next({ ops: { ...op("r2", { entityId: "my", nodeId: "peer", hlc: "1700000000006:0:peer" }), seq: 6 } });
    expect(engine.store.lastSeq("b1")).toBe(6);
    expect(engine.readBoard({ boardId: "b1" }).missions.map((m) => m.id).sort()).toEqual(["mx", "my"]);
    expect(events.filter((e) => e.t === "db:board")).toHaveLength(2);
    await engine.syncBoard({ boardId: "b1" });
    expect(gql.sinks.size).toBe(1);
    engine.close();
    expect(gql.sinks.size).toBe(0);
  });

  test("a board synced before the gql link catches up when the link arrives", async () => {
    const { engine } = makeEngine({ gql: null });
    expect(await engine.syncBoard({ boardId: "b1" })).toEqual({ lastSeq: 0, pulled: 0, subscribed: false });
    const gql = fakeGql(({ query }) => (query.includes("opsSince") ? { data: { opsSince: [] } } : { data: { applyOps: { applied: 0, duplicates: 0, lastSeq: 0 } } }));
    engine.setGql(gql);
    await new Promise((r) => setTimeout(r, 0));
    expect(gql.calls.some((c) => c.query.includes("opsSince"))).toBe(true);
  });
});

describe("frames", () => {
  const to = T0 + 2 * 24 * H;
  const from = new Date(T0).toISOString();
  const toIso = new Date(to).toISOString();
  const axis = frameAxis(from, toIso);
  const geometry = { west: -83.2, south: 24.3, hsCellDeg: 0.02, envCellDeg: 0.05 };

  /** Serves any requested range from the fixture encoder, with an etag per range. */
  function framesServer(salt = 0) {
    const requests: string[] = [];
    let notModified = 0;
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      requests.push(url);
      const u = new URL(url, "http://stub");
      const f = Date.parse(u.searchParams.get("from")!);
      const t = Date.parse(u.searchParams.get("to")!);
      const step = Number(u.searchParams.get("step"));
      const etag = `"${f}-${t}-${step}-${salt}"`;
      const sent = new Headers(init?.headers);
      if (sent.get("if-none-match") === etag) {
        notModified += 1;
        return new Response(null, { status: 304 });
      }
      const frameCount = Math.floor((t - f) / (step * 60_000)) + 1;
      const body = encodeEvf2({ frame0UnixMs: f, stepMinutes: step, frameCount, salt });
      return new Response(body.slice().buffer, { status: 200, headers: { etag, "content-type": "application/x-evf" } });
    };
    return { fetchImpl, requests, notModified: () => notModified };
  }

  test("refresh fetches the hourly window, fills a shared grid, publishes it once with meta and sightings, and caches frames", async () => {
    const server = framesServer();
    const { engine, events } = makeEngine({ fetchImpl: server.fetchImpl, shared: true });
    const res = await engine.framesRefresh({ from, to: toIso });
    expect(res).toEqual({ frameCount: 49, cached: 0, fetched: 49, failed: 0 });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toContain("step=60");
    const grids = events.filter((e) => e.t === "db:grid") as Extract<DbEvent, { t: "db:grid" }>[];
    expect(grids).toHaveLength(1);
    expect(events.filter((e) => e.t === "db:grid-bumped")).toHaveLength(0);
    expect(grids[0]!.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(grids[0]!.meta).toEqual({ ...axis, geometry });
    const packs = events.filter((e) => e.t === "db:sightings") as Extract<DbEvent, { t: "db:sightings" }>[];
    expect(packs).toHaveLength(1);
    const s = unpackSightings(packs[0]!.pack);
    expect(s.counts.length).toBe(49);
    expect(s.records(3)[1]!.id).toBe(sightingId(3, 1));
    expect(engine.store.frameCount()).toBe(49);
    const snap = engine.framesSnapshot();
    const grid = attachGrid(snap.buffer!);
    expect(grid.hotspot(3, 1)[7]).toBe(hotspotValue(3, 1, 7));
    expect(snap.meta).toEqual({ ...axis, geometry });
    expect(totalSightings(snap.sightings!)).toBe(98);
    expect(engine.frameSightings({ atMs: T0 + 2 * H })).toHaveLength(2);
    expect(engine.stats()).toMatchObject({ grid: { frameCount: 49, version: 1, shared: true }, sightings: 98, frames: 49 });
  });

  test("a second engine over the same rows serves the window from cache and sends etags", async () => {
    const server = framesServer();
    const first = makeEngine({ fetchImpl: server.fetchImpl });
    await first.engine.framesRefresh({ from, to: toIso });
    const events: DbEvent[] = [];
    const again = new DbEngine({
      store: first.engine.store,
      gql: null,
      fetchImpl: server.fetchImpl,
      framesUrl: "/v1/frames",
      shared: true,
      opfs: false,
      post: (e) => events.push(e),
    });
    const res = await again.framesRefresh({ from, to: toIso });
    expect(res).toEqual({ frameCount: 49, cached: 49, fetched: 0, failed: 0 });
    expect(server.requests).toHaveLength(1);
    expect(events.map((e) => e.t)).toEqual(["db:grid", "db:sightings"]);
    expect(totalSightings(again.sightingsPack())).toBe(98);
    // A forced refetch presents the stored etag and gets a 304.
    const forced = await again.framesRefresh({ from, to: toIso, force: true });
    expect(forced.fetched).toBe(0);
    expect(server.notModified()).toBe(1);
  });

  test("framesUpdated refetches only the touched hours, bumps the grid and re-sends sightings", async () => {
    const server = framesServer();
    const { engine, events } = makeEngine({ fetchImpl: server.fetchImpl });
    await engine.framesRefresh({ from, to: toIso });
    const before = events.length;
    await engine.framesUpdated(new Date(to - H - 1).toISOString(), toIso);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]).toContain(`from=${encodeURIComponent(new Date(to - H).toISOString())}`);
    expect(events.slice(before).map((e) => e.t)).toEqual(["db:grid-bumped", "db:sightings"]);
    expect((events[before] as Extract<DbEvent, { t: "db:grid-bumped" }>).version).toBe(2);
  });

  test("a moved window reallocates: cached hours come back at their new index, the rest is fetched", async () => {
    const server = framesServer();
    const { engine, events } = makeEngine({ fetchImpl: server.fetchImpl });
    await engine.framesRefresh({ from, to: toIso });
    const res = await engine.framesRefresh({ from: new Date(T0 + 2 * H).toISOString(), to: new Date(to + 2 * H).toISOString() });
    expect(res).toEqual({ frameCount: 49, cached: 47, fetched: 2, failed: 0 });
    expect(server.requests[1]).toContain(`from=${encodeURIComponent(new Date(to + H).toISOString())}`);
    const grids = events.filter((e) => e.t === "db:grid") as Extract<DbEvent, { t: "db:grid" }>[];
    expect(grids).toHaveLength(2);
    expect(grids[1]!.meta.frame0UnixMs).toBe(T0 + 2 * H);
    const grid = attachGrid(engine.framesSnapshot().buffer!);
    // Hour T0+5h was fixture frame 5 in the first fetch; it now sits at index 3.
    expect(grid.hotspot(3, 2)[9]).toBe(hotspotValue(5, 2, 9));
    expect(engine.store.frameCount()).toBe(49); // pruned below the new window
  });

  test("without SharedArrayBuffer the grid is transferred as a fresh ArrayBuffer on every publish", async () => {
    const server = framesServer();
    const { engine, events, transfers } = makeEngine({ fetchImpl: server.fetchImpl, shared: false });
    await engine.framesRefresh({ from, to: toIso });
    await engine.framesUpdated(toIso, toIso);
    const grids = events.filter((e) => e.t === "db:grid") as Extract<DbEvent, { t: "db:grid" }>[];
    expect(grids).toHaveLength(2);
    for (const g of grids) {
      expect(g.buffer).toBeInstanceOf(ArrayBuffer);
      expect(g.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      expect(transfers[events.indexOf(g)]).toEqual([g.buffer]);
    }
    const pack = events.find((e) => e.t === "db:sightings") as Extract<DbEvent, { t: "db:sightings" }>;
    expect(transfers[events.indexOf(pack)]).toHaveLength(3);
    expect(engine.stats().grid?.shared).toBe(false);
  });

  test("a failing chunk is counted, the rest still lands", async () => {
    const server = framesServer();
    let calls = 0;
    const fetchImpl = (url: string, init?: RequestInit) => (++calls === 1 ? Promise.resolve(new Response("nope", { status: 500 })) : server.fetchImpl(url, init));
    const orig = console.warn;
    console.warn = () => {};
    try {
      const { engine } = makeEngine({ fetchImpl });
      const res = await engine.framesRefresh({ from, to: toIso });
      expect(res).toEqual({ frameCount: 49, cached: 0, fetched: 0, failed: 1 });
      const again = await engine.framesRefresh({ from, to: toIso });
      expect(again).toEqual({ frameCount: 49, cached: 0, fetched: 49, failed: 0 });
    } finally {
      console.warn = orig;
    }
  });
});
