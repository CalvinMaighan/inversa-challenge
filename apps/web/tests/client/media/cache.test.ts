import { describe, expect, test } from "bun:test";

import {
  loadMedia,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_NAME,
  MEDIA_INDEX_KEY,
  planEviction,
  readIndex,
  REVALIDATE_AFTER_MS,
  revalidate,
  type MediaDeps,
} from "client/media/cache";

/** In-memory CacheStorage: one named cache, Responses kept as bytes. */
function fakeCaches() {
  const stores = new Map<string, Map<string, { body: ArrayBuffer; type: string }>>();
  const opened: string[] = [];
  return {
    opened,
    entries: (name = MEDIA_CACHE_NAME) => [...(stores.get(name)?.keys() ?? [])].sort(),
    async open(name: string) {
      opened.push(name);
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        async match(url: RequestInfo | URL) {
          const hit = m.get(String(url));
          return hit ? new Response(hit.body.slice(0), { headers: { "content-type": hit.type } }) : undefined;
        },
        async put(url: RequestInfo | URL, res: Response) {
          m.set(String(url), { body: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "" });
        },
        async delete(url: RequestInfo | URL) {
          return m.delete(String(url));
        },
      } as unknown as Cache;
    },
  };
}

function setup(opts: { sizes?: Record<string, number>; maxBytes?: number; caches?: boolean; status?: number; type?: string } = {}) {
  const caches = fakeCaches();
  const map = new Map<string, string>();
  const fetched: string[] = [];
  let version = 1;
  let now = Date.parse("2026-10-01T12:00:00Z");
  const deps: MediaDeps = {
    caches: opts.caches === false ? null : caches,
    store: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) },
    now: () => now,
    maxBytes: opts.maxBytes ?? MEDIA_CACHE_MAX_BYTES,
    async fetch(url) {
      fetched.push(url);
      const size = opts.sizes?.[url] ?? 10;
      const bytes = new Uint8Array(size).fill(version);
      return new Response(bytes, { status: opts.status ?? 200, headers: { "content-type": opts.type ?? "image/jpeg" } });
    },
  };
  return {
    deps,
    caches,
    fetched,
    index: () => readIndex(deps.store),
    advance: (ms: number) => void (now += ms),
    bump: () => void (version += 1),
  };
}

const firstByte = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())[0];

describe("media cache", () => {
  test("first load from the network, second from the Cache API without a request", async () => {
    const s = setup();
    const url = "/v1/python/media/48213";
    const one = await loadMedia(url, s.deps);
    expect(one.source).toBe("network");
    expect(one.blob.size).toBe(10);
    const two = await loadMedia(url, s.deps);
    expect(two.source).toBe("cache");
    expect(two.blob.size).toBe(10);
    expect(s.fetched).toEqual([url]);
    expect(s.caches.opened.every((n) => n === MEDIA_CACHE_NAME)).toBe(true);
    expect(s.index()[url]).toMatchObject({ bytes: 10 });
    expect(MEDIA_CACHE_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  test("stale-while-revalidate: an old copy is served at once and refreshed in the background", async () => {
    const s = setup();
    const url = "/v1/carp/media/7";
    await loadMedia(url, s.deps);
    s.bump();
    s.advance(REVALIDATE_AFTER_MS - 1);
    expect((await loadMedia(url, s.deps)).source).toBe("cache");
    expect(s.fetched.length).toBe(1);
    s.advance(2);
    const stale = await loadMedia(url, s.deps);
    expect(stale.source).toBe("cache");
    expect(await firstByte(stale.blob)).toBe(1);
    // The background fetch was started (deduplicated per URL); once it lands the next read is the fresh copy.
    const cache = await s.deps.caches!.open(MEDIA_CACHE_NAME);
    await revalidate(s.deps, cache, url);
    expect(s.fetched.length).toBeGreaterThanOrEqual(2);
    const fresh = await loadMedia(url, s.deps);
    expect(fresh.source).toBe("cache");
    expect(await firstByte(fresh.blob)).toBe(2);
  });

  test("bounded with LRU eviction: the least recently used photo goes first", async () => {
    const s = setup({ maxBytes: 250, sizes: { "/m/a": 100, "/m/b": 100, "/m/c": 100, "/m/huge": 300 } });
    await loadMedia("/m/a", s.deps);
    s.advance(1_000);
    await loadMedia("/m/b", s.deps);
    s.advance(1_000);
    await loadMedia("/m/a", s.deps); // a is now more recent than b
    s.advance(1_000);
    await loadMedia("/m/c", s.deps);
    expect(s.caches.entries()).toEqual(["/m/a", "/m/c"]);
    expect(Object.keys(s.index()).sort()).toEqual(["/m/a", "/m/c"]);
    expect(Object.values(s.index()).reduce((n, e) => n + e.bytes, 0)).toBeLessThanOrEqual(250);
    // Larger than the whole budget: shown, never stored.
    expect((await loadMedia("/m/huge", s.deps)).source).toBe("network");
    expect(s.caches.entries()).toEqual(["/m/a", "/m/c"]);
  });

  test("planEviction drops oldest first until the rest fits", () => {
    const index = { a: { bytes: 50, usedAt: 3, fetchedAt: 0 }, b: { bytes: 50, usedAt: 1, fetchedAt: 0 }, c: { bytes: 50, usedAt: 2, fetchedAt: 0 } };
    expect(planEviction(index, 150)).toEqual([]);
    expect(planEviction(index, 100)).toEqual(["b"]);
    expect(planEviction(index, 40)).toEqual(["b", "c", "a"]);
  });

  test("only image answers are stored; errors throw; without the Cache API every load is a network load", async () => {
    const text = setup({ type: "text/html" });
    expect((await loadMedia("/m/x", text.deps)).source).toBe("network");
    expect((await loadMedia("/m/x", text.deps)).source).toBe("network");
    expect(text.caches.entries()).toEqual([]);
    const missing = setup({ status: 404 });
    await expect(loadMedia("/m/404", missing.deps)).rejects.toThrow("media 404");
    const none = setup({ caches: false });
    await loadMedia("/m/y", none.deps);
    expect((await loadMedia("/m/y", none.deps)).source).toBe("network");
    expect(none.fetched).toEqual(["/m/y", "/m/y"]);
    // A cache whose open throws (storage blocked) degrades the same way.
    const blocked = setup();
    blocked.deps.caches = { open: () => Promise.reject(new Error("SecurityError")) };
    expect((await loadMedia("/m/z", blocked.deps)).source).toBe("network");
  });

  test("a corrupt or foreign index is ignored entry by entry", () => {
    const s = setup();
    s.deps.store!.setItem(MEDIA_INDEX_KEY, JSON.stringify({ "/ok": { bytes: 1, usedAt: 2, fetchedAt: 3 }, "/bad": { bytes: "x" }, "/neg": { bytes: -1, usedAt: 0, fetchedAt: 0 } }));
    expect(readIndex(s.deps.store)).toEqual({ "/ok": { bytes: 1, usedAt: 2, fetchedAt: 3 } });
    s.deps.store!.setItem(MEDIA_INDEX_KEY, "{not json");
    expect(readIndex(s.deps.store)).toEqual({});
  });
});
