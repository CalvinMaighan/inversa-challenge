import { describe, expect, test } from "bun:test";

import { cacheDecision, DEFAULT_TTL_MS, MAX_STALE_MS, queryHash, ROOT_TTL_MS, rootField, ttlForQuery, type CacheRow } from "client/threads/db/cache";

const row = (fetchedAt: number, ttlMs: number): CacheRow => ({ hash: "h", json: "{}", fetchedAt, ttlMs });

describe("cacheDecision", () => {
  test("no row is a miss", () => {
    expect(cacheDecision(null, 1000)).toBe("miss");
    expect(cacheDecision(undefined, 1000)).toBe("miss");
  });

  test("within ttl is fresh, inclusive at the boundary", () => {
    expect(cacheDecision(row(1000, 500), 1400)).toBe("fresh");
    expect(cacheDecision(row(1000, 500), 1500)).toBe("fresh");
  });

  test("past ttl but within the stale bound serves stale", () => {
    expect(cacheDecision(row(1000, 500), 1501)).toBe("stale");
    expect(cacheDecision(row(1000, 500), 1000 + MAX_STALE_MS)).toBe("stale");
  });

  test("past the stale bound is a miss", () => {
    expect(cacheDecision(row(1000, 500), 1000 + MAX_STALE_MS + 1)).toBe("miss");
  });

  test("a clock that went backwards still counts as fresh", () => {
    expect(cacheDecision(row(5000, 500), 4000)).toBe("fresh");
  });

  test("zero ttl rows never serve", () => {
    expect(cacheDecision(row(1000, 0), 1000)).toBe("miss");
  });
});

describe("ttlForQuery", () => {
  test("root field parsing handles shorthand, named operations, aliases and arguments", () => {
    expect(rootField("{ feeds { source } }")).toBe("feeds");
    expect(rootField("query Feeds { feeds { source } }")).toBe("feeds");
    expect(rootField("query S($b: BBox!) { sightings(bbox: $b) { id } }")).toBe("sightings");
    expect(rootField("query { hot: hotspots(species: \"python\") { cells { cell } } }")).toBe("hotspots");
    expect(rootField("\n  query Board($id: ID!) {\n    board(id: $id) { id }\n  }")).toBe("board");
  });

  test("mutations and subscriptions are never cached", () => {
    expect(ttlForQuery("mutation A($b: ID!, $o: [OpInput!]!) { applyOps(boardId: $b, ops: $o) { applied } }")).toBe(0);
    expect(ttlForQuery("subscription { feeds { source } }")).toBe(0);
    expect(rootField("garbage")).toBeNull();
    expect(ttlForQuery("garbage")).toBe(0);
  });

  test("ttl follows the root table, unknown roots get the default", () => {
    expect(ttlForQuery("{ feeds { source } }")).toBe(ROOT_TTL_MS.feeds!);
    expect(ttlForQuery("{ backtest(species: \"tegu\", days: 30) { hitRate } }")).toBe(ROOT_TTL_MS.backtest!);
    expect(ttlForQuery("{ board(id: \"b\") { id } }")).toBe(0);
    expect(ttlForQuery("{ opsSince(boardId: \"b\", seq: 0) { id } }")).toBe(0);
    expect(ttlForQuery("{ somethingNew { x } }")).toBe(DEFAULT_TTL_MS);
  });
});

describe("queryHash", () => {
  test("is stable across whitespace and variable key order", () => {
    const a = queryHash("{ feeds { source } }", { x: 1, y: [1, 2], z: { b: 2, a: 1 } });
    const b = queryHash("{\n  feeds {\n    source\n  }\n}", { z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("differs by query text and by variables", () => {
    expect(queryHash("{ feeds { source } }")).not.toBe(queryHash("{ feeds { mode } }"));
    expect(queryHash("{ a }", { x: 1 })).not.toBe(queryHash("{ a }", { x: 2 }));
    expect(queryHash("{ a }", { x: undefined })).toBe(queryHash("{ a }", {}));
  });
});
