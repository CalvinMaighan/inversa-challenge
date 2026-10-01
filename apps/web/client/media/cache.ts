/**
 * Local media cache (docs/GODS_EYE.md GE3): sighting photos from the same-origin proxy `/v1/<app>/media/<id>`
 * kept in the Cache API, so a photo seen once opens instantly and offline.
 *
 * - Stale-while-revalidate: a cached photo is returned at once; when it is older than `REVALIDATE_AFTER_MS` it is
 *   fetched again in the background (once per URL at a time) and the fresh copy replaces it.
 * - Bounded: at most `MEDIA_CACHE_MAX_BYTES` (200 MB); past that the least recently used photos are evicted. The
 *   sizes and last-use times live in a small localStorage index beside the cache.
 * - Only `image/*` answers with a 2xx status are stored; anything else is served once and forgotten.
 *
 * Where the Cache API is missing (an insecure origin, an old browser) or throws, photos load from the network.
 */

export const MEDIA_CACHE_NAME = "inversa-media-v1";
export const MEDIA_CACHE_MAX_BYTES = 200 * 1024 * 1024;
export const MEDIA_INDEX_KEY = "inversa:media-lru";
export const REVALIDATE_AFTER_MS = 6 * 60 * 60 * 1000;

export type MediaSource = "network" | "cache";
export type MediaIndexEntry = { bytes: number; usedAt: number; fetchedAt: number };
export type MediaIndex = Record<string, MediaIndexEntry>;

type IndexStore = Pick<Storage, "getItem" | "setItem">;
type CacheLike = Pick<Cache, "match" | "put" | "delete">;

export type MediaDeps = {
  caches: { open(name: string): Promise<CacheLike> } | null;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  store: IndexStore | null;
  now: () => number;
  maxBytes: number;
};

/** URLs to evict, least recently used first, until the rest fits in `maxBytes`. */
export function planEviction(index: MediaIndex, maxBytes: number): string[] {
  let total = Object.values(index).reduce((n, e) => n + e.bytes, 0);
  const out: string[] = [];
  for (const [url, e] of Object.entries(index).sort((a, b) => a[1].usedAt - b[1].usedAt)) {
    if (total <= maxBytes) break;
    out.push(url);
    total -= e.bytes;
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function readIndex(store: IndexStore | null): MediaIndex {
  try {
    const parsed = JSON.parse(store?.getItem(MEDIA_INDEX_KEY) ?? "{}") as Record<string, Partial<MediaIndexEntry>>;
    const out: MediaIndex = {};
    for (const [url, e] of Object.entries(parsed ?? {})) {
      if (e && finite(e.bytes) && finite(e.usedAt) && finite(e.fetchedAt)) out[url] = { bytes: e.bytes, usedAt: e.usedAt, fetchedAt: e.fetchedAt };
    }
    return out;
  } catch {
    return {};
  }
}

function writeIndex(store: IndexStore | null, index: MediaIndex): void {
  try {
    store?.setItem(MEDIA_INDEX_KEY, JSON.stringify(index));
  } catch {
    // Storage full or blocked: eviction falls back to what this page load knows.
  }
}

export function browserMediaDeps(): MediaDeps {
  let caches: MediaDeps["caches"] = null;
  let store: IndexStore | null = null;
  try {
    caches = typeof globalThis.caches === "undefined" ? null : globalThis.caches;
  } catch {
    caches = null;
  }
  try {
    store = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    store = null;
  }
  return { caches, fetch: (url, init) => fetch(url, init), store, now: Date.now, maxBytes: MEDIA_CACHE_MAX_BYTES };
}

const cacheable = (res: Response) => res.ok && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/");

async function fetchImage(deps: MediaDeps, url: string): Promise<Response> {
  const res = await deps.fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`media ${res.status}`);
  return res;
}

/** Store a fetched photo, record it in the index and evict down to the budget. */
async function store(deps: MediaDeps, cache: CacheLike, url: string, blob: Blob, type: string): Promise<void> {
  if (blob.size > deps.maxBytes) return;
  await cache.put(url, new Response(blob, { headers: { "content-type": type, "content-length": String(blob.size) } }));
  const index = readIndex(deps.store);
  const now = deps.now();
  index[url] = { bytes: blob.size, usedAt: now, fetchedAt: now };
  for (const old of planEviction(index, deps.maxBytes)) {
    delete index[old];
    await cache.delete(old);
  }
  writeIndex(deps.store, index);
}

const revalidating = new Map<string, Promise<void>>();

/** Fetch `url` again and replace the cached copy; one at a time per URL; failures keep the stale copy. */
export function revalidate(deps: MediaDeps, cache: CacheLike, url: string): Promise<void> {
  const running = revalidating.get(url);
  if (running) return running;
  const job = (async () => {
    try {
      const res = await fetchImage(deps, url);
      if (cacheable(res)) await store(deps, cache, url, await res.blob(), res.headers.get("content-type")!);
    } catch {
      // Offline or upstream down: the stale copy stays.
    } finally {
      revalidating.delete(url);
    }
  })();
  revalidating.set(url, job);
  return job;
}

/** A photo as a Blob and where it came from. Throws only when the network fails and nothing is cached. */
export async function loadMedia(url: string, deps: MediaDeps = browserMediaDeps()): Promise<{ blob: Blob; source: MediaSource }> {
  let cache: CacheLike | null = null;
  try {
    cache = deps.caches ? await deps.caches.open(MEDIA_CACHE_NAME) : null;
  } catch {
    cache = null;
  }
  if (cache) {
    let hit: Response | undefined;
    try {
      hit = await cache.match(url);
    } catch {
      hit = undefined;
    }
    if (hit) {
      const blob = await hit.blob();
      const index = readIndex(deps.store);
      const now = deps.now();
      // An entry the index lost (cleared storage) counts as fetched now.
      const entry = index[url] ?? { bytes: blob.size, usedAt: now, fetchedAt: now };
      index[url] = { ...entry, usedAt: now };
      writeIndex(deps.store, index);
      if (now - entry.fetchedAt > REVALIDATE_AFTER_MS) void revalidate(deps, cache, url);
      return { blob, source: "cache" };
    }
  }
  const res = await fetchImage(deps, url);
  const blob = await res.blob();
  if (cache && cacheable(res)) {
    try {
      await store(deps, cache, url, blob, res.headers.get("content-type")!);
    } catch {
      // Quota exceeded or the cache went away: the photo still shows.
    }
  }
  return { blob, source: "network" };
}
