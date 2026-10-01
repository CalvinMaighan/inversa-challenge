/**
 * The search box's engine and the sighting card's access lookup (docs/places.md), over injected dependencies so
 * the tests drive them with fixtures, a fake clock and a recording fetch: never the network, never a key.
 *
 * Modes:
 *   google   a Google key and the Google 3D map in use: local gazetteer + Places (New) Text Search. Photon is not
 *            mixed in, because Google's tiles are loaded with `onlyUsingWithGoogleGeocoder` (Map Tiles terms).
 *   keyless  no key (or the Google 3D cap reached, so the map is not Google's): local gazetteer + Photon, and the
 *            box says "Search is limited without a Google key" when there is no key.
 *   capped   the session's Places request cap is reached: local gazetteer only, and the box says so.
 *
 * Typing is debounced; a newer query aborts the older request and resolves the older call with null. The same
 * query (mode, area, language) within 10 minutes is answered from memory with no request. Nothing is persisted.
 */
import type { BBox } from "shared/agent/events";
import {
  localMatches,
  mergeAccess,
  mergeHits,
  nearbyMarinasRequest,
  normalizeQuery,
  parseAccess,
  parsePhoton,
  parseTextSearch,
  photonRequest,
  rampSearchRequest,
  textSearchRequest,
  type AccessPlace,
  type HttpRequest,
  type LatLon,
  type LocalPlace,
  type PlaceHit,
} from "shared/places";

import { takePlacesRequests, type KeyValueStore } from "./budget";

export const SEARCH_DEBOUNCE_MS = 300;
export const CACHE_TTL_MS = 10 * 60_000;
export const MIN_REMOTE_CHARS = 2;

export const LIMITED_MESSAGE = "Search is limited without a Google key";
export const CAPPED_MESSAGE = "Google search limit for this session reached. Showing local places only; raise the limit in Developer settings.";

export type SearchMode = "google" | "keyless" | "capped";

export type SearchDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  /** The browser Google key, or undefined. Read on every search: the Developer panel may add one. */
  key: () => string | undefined;
  /** False when the Google 3D map is not in use (its monthly cap reached): Google content then stays out. */
  googleMap: () => boolean;
  bbox: () => BBox;
  language: () => string;
  origins: () => { google: string; photon: string };
  localPlaces: () => readonly LocalPlace[];
  store: KeyValueStore | null;
  session: KeyValueStore | null;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type SearchResult = {
  query: string;
  hits: PlaceHit[];
  mode: SearchMode;
  /** "Search is limited without a Google key", the cap message, or null. */
  notice: string | null;
  /** Remote lookup failed (network, HTTP status); local hits still shown. */
  error: string | null;
  /** Which remote service answered (for the credit line), or null for local only. */
  provider: "google" | "photon" | null;
};

type CacheEntry = { at: number; hits: PlaceHit[]; provider: "google" | "photon" };

/** Shared by the search box and the access list: one memory cache per page, keyed by request identity. */
export class TtlCache<T> {
  private map = new Map<string, { at: number; value: T }>();
  constructor(private ttlMs = CACHE_TTL_MS) {}
  get(key: string, now: number): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T, now: number): void {
    this.map.set(key, { at: now, value });
    // Keep it small: drop the oldest beyond 100 entries.
    if (this.map.size > 100) this.map.delete(this.map.keys().next().value!);
  }
}

async function send(deps: Pick<SearchDeps, "fetch">, req: HttpRequest, signal?: AbortSignal): Promise<unknown> {
  const res = await deps.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal, mode: "cors", credentials: "omit", cache: "no-store" });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { status?: string; message?: string } };
      detail = body.error?.status ? ` ${body.error.status}` : "";
    } catch {
      // Not JSON: the status says enough.
    }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return res.json();
}

export function searchMode(deps: SearchDeps): { mode: SearchMode | "google-ready"; key: string | undefined } {
  const key = deps.key()?.trim() || undefined;
  if (!key || !deps.googleMap()) return { mode: "keyless", key: undefined };
  return { mode: "google-ready", key };
}

export type PlaceSearch = {
  /** Debounced: resolves with the result, or null when a newer call superseded this one. */
  search(query: string): Promise<SearchResult | null>;
  /** Abort what is pending (the popover closed). */
  cancel(): void;
};

export function createPlaceSearch(deps: SearchDeps, opts: { debounceMs?: number; cache?: TtlCache<CacheEntry> } = {}): PlaceSearch {
  const debounceMs = opts.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const cache = opts.cache ?? new TtlCache<CacheEntry>();
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let settlePending: ((r: SearchResult | null) => void) | null = null;

  const supersede = () => {
    if (timer !== null) clearT(timer);
    timer = null;
    controller?.abort();
    controller = null;
    settlePending?.(null);
    settlePending = null;
  };

  async function run(query: string, signal: AbortSignal): Promise<SearchResult> {
    const box = deps.bbox();
    const language = deps.language();
    const local = localMatches(query, deps.localPlaces(), box);
    const { mode: m, key } = searchMode(deps);
    const noKey = !deps.key()?.trim();
    const base = { query, error: null as string | null };
    if (normalizeQuery(query).length < MIN_REMOTE_CHARS) {
      return { ...base, hits: local, mode: m === "google-ready" ? "google" : "keyless", notice: noKey ? LIMITED_MESSAGE : null, provider: null };
    }
    const mode: SearchMode = m === "google-ready" ? "google" : "keyless";
    const cacheKey = [mode, language, box.west, box.south, box.east, box.north, normalizeQuery(query)].join("|");
    const cached = cache.get(cacheKey, deps.now());
    if (cached) return { ...base, hits: mergeHits(local, cached.hits), mode, notice: noKey ? LIMITED_MESSAGE : null, provider: cached.provider };

    if (mode === "google") {
      if (!takePlacesRequests(deps.store, deps.session, 1)) return { ...base, hits: local, mode: "capped", notice: CAPPED_MESSAGE, provider: null };
      try {
        const json = await send(deps, textSearchRequest(query, box, { key: key!, language, origin: deps.origins().google }), signal);
        const hits = parseTextSearch(json);
        cache.set(cacheKey, { at: deps.now(), hits, provider: "google" }, deps.now());
        return { ...base, hits: mergeHits(local, hits), mode, notice: null, provider: "google" };
      } catch (err) {
        if (signal.aborted) throw err;
        return { ...base, hits: local, mode, notice: null, provider: null, error: `Google search failed (${(err as Error).message}).` };
      }
    }
    try {
      const json = await send(deps, photonRequest(query, box, { language, origin: deps.origins().photon }), signal);
      const hits = parsePhoton(json);
      cache.set(cacheKey, { at: deps.now(), hits, provider: "photon" }, deps.now());
      return { ...base, hits: mergeHits(local, hits), mode, notice: noKey ? LIMITED_MESSAGE : null, provider: "photon" };
    } catch (err) {
      if (signal.aborted) throw err;
      return { ...base, hits: local, mode, notice: noKey ? LIMITED_MESSAGE : null, provider: null, error: `OpenStreetMap search failed (${(err as Error).message}).` };
    }
  }

  return {
    search(query) {
      supersede();
      return new Promise<SearchResult | null>((resolve) => {
        settlePending = resolve;
        timer = setT(() => {
          timer = null;
          const c = new AbortController();
          controller = c;
          run(query, c.signal).then(
            (r) => {
              if (c.signal.aborted) return;
              controller = null;
              settlePending = null;
              resolve(r);
            },
            () => {
              // Aborted: the newer call already resolved this one with null.
            },
          );
        }, debounceMs);
      });
    },
    cancel: supersede,
  };
}

// ---- boat ramps and marinas near a sighting ---------------------------------------------------------------

export type AccessResult =
  | { status: "ok"; places: AccessPlace[] }
  | { status: "no-key" }
  /** A key, but the globe is not showing Google's map (its 3D monthly cap reached): Places content stays out. */
  | { status: "no-map" }
  | { status: "capped" }
  | { status: "error"; message: string };

export const NO_ACCESS_MESSAGE = "No boat ramps found within 10 km";

const accessCache = new TtlCache<AccessPlace[]>();

/**
 * Marinas (Nearby Search, type `marina`) and boat ramps (Text Search "boat ramp" in the same area) within 10 km of
 * a sighting, nearest first. Two Places requests, counted against the session cap together; cached 10 minutes.
 */
export async function loadAccess(at: LatLon, deps: Omit<SearchDeps, "bbox" | "localPlaces" | "setTimeout" | "clearTimeout">, signal?: AbortSignal, cache = accessCache): Promise<AccessResult> {
  const key = deps.key()?.trim();
  if (!key) return { status: "no-key" };
  if (!deps.googleMap()) return { status: "no-map" };
  const language = deps.language();
  const cacheKey = [language, at.lat.toFixed(4), at.lon.toFixed(4)].join("|");
  const cached = cache.get(cacheKey, deps.now());
  if (cached) return { status: "ok", places: cached };
  if (!takePlacesRequests(deps.store, deps.session, 2)) return { status: "capped" };
  const o = { key, language, origin: deps.origins().google };
  try {
    const [marinas, ramps] = await Promise.all([send(deps, nearbyMarinasRequest(at, o), signal), send(deps, rampSearchRequest(at, o), signal)]);
    const places = mergeAccess([parseAccess(marinas, at, "marina"), parseAccess(ramps, at, "ramp")]);
    cache.set(cacheKey, places, deps.now());
    return { status: "ok", places };
  } catch (err) {
    return { status: "error", message: `Google Places did not answer (${(err as Error).message}).` };
  }
}
