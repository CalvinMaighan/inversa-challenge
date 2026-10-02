import { beforeEach, describe, expect, test } from "bun:test";

import { PLACES_CAP_STORAGE_KEY, PLACES_COUNT_STORAGE_KEY, placesUsed, readPlacesCap, resetPlacesMemoryCount, savePlacesCapField, takePlacesRequests, writePlacesCap } from "client/places/budget";
import { overrideOrigin, placesOrigins, PLACES_BASE_STORAGE_KEY } from "client/places/browser";
import { altitudeFor, POINT_ALTITUDE_M, viewForHit } from "client/places/fly";
import { CACHE_TTL_MS, CAPPED_MESSAGE, createPlaceSearch, LIMITED_MESSAGE, loadAccess, NO_ACCESS_MESSAGE, TtlCache, type SearchDeps } from "client/places/search";
import { viewFor } from "client/state/view";
import { appBBox, getApp } from "shared/apps";
import type { AccessPlace } from "shared/places";

import nearbyFixture from "../../fixtures/places/nearby-marinas.json";
import photonFixture from "../../fixtures/places/photon.json";
import rampFixture from "../../fixtures/places/ramp-search.json";
import textFixture from "../../fixtures/places/text-search.json";

class MemoryStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

type Call = { url: string; init: RequestInit };

/** A recording fetch over fixtures: no network, and an abort rejects like the real one. */
function stubFetch(route: (url: string, body: Record<string, unknown> | null) => unknown, calls: Call[], opts: { delayMs?: number; status?: number } = {}) {
  return (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      const done = () => {
        const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        resolve(new Response(JSON.stringify(route(url, body)), { status: opts.status ?? 200, headers: { "content-type": "application/json" } }));
      };
      if (init.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(done, opts.delayMs ?? 0);
    });
  };
}

const fixtureRoute = (url: string, body: Record<string, unknown> | null) => {
  if (url.includes("photon") || url.includes("/api/")) return photonFixture;
  if (url.endsWith(":searchNearby")) return nearbyFixture;
  if (body?.textQuery === "boat ramp") return rampFixture;
  return textFixture;
};

const LOCAL = [{ name: "Flamingo", lat: 25.1417, lon: -80.9237 }];

function deps(over: Partial<SearchDeps> = {}, calls: Call[] = []): SearchDeps {
  return {
    fetch: stubFetch(fixtureRoute, calls),
    now: () => 1_000_000,
    key: () => "test-placeholder",
    googleMap: () => true,
    bbox: () => appBBox(getApp("python")),
    language: () => "en-US",
    origins: () => ({ google: "https://places.googleapis.com", photon: "https://photon.komoot.io" }),
    localPlaces: () => LOCAL,
    store: new MemoryStore(),
    session: new MemoryStore(),
    // Real timers with a short debounce: the tests wait for them.
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => resetPlacesMemoryCount());

describe("place search", () => {
  test("a Google search: one request with key header, local hits first, Google credit", async () => {
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({}, calls), { debounceMs: 5 });
    const r = await s.search("Flamingo");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("test-placeholder");
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(r!.mode).toBe("google");
    expect(r!.provider).toBe("google");
    expect(r!.notice).toBeNull();
    expect(r!.hits[0]!.source).toBe("local");
    expect(r!.hits.map((h) => h.id)).toContain("fixture-place-flamingo-gardens");
  });

  test("debounce: rapid typing sends one request, for the last text; earlier calls resolve null", async () => {
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({}, calls), { debounceMs: 30 });
    const a = s.search("Fl");
    const b = s.search("Flam");
    const c = s.search("Flamingo");
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect((await c)!.query).toBe("Flamingo");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body as string).textQuery).toBe("Flamingo");
  });

  test("abort: a newer query aborts the request in flight", async () => {
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({ fetch: stubFetch(fixtureRoute, calls, { delayMs: 80 }) }), { debounceMs: 1 });
    const first = s.search("Flamingo");
    await sleep(20); // past the debounce: the first request is in flight
    expect(calls).toHaveLength(1);
    const second = s.search("Flamingo Gardens");
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    expect(await first).toBeNull();
    expect((await second)!.query).toBe("Flamingo Gardens");
    expect(calls).toHaveLength(2);
  });

  test("cache: the same query within 10 minutes makes no second request; after 10 minutes it does", async () => {
    const calls: Call[] = [];
    let now = 5_000_000;
    const d = deps({ now: () => now }, calls);
    const s = createPlaceSearch(d, { debounceMs: 1 });
    await s.search("Flamingo");
    now += CACHE_TTL_MS - 1;
    const again = await s.search("flamingo ");
    expect(calls).toHaveLength(1);
    expect(again!.provider).toBe("google");
    expect(again!.hits.length).toBeGreaterThan(1);
    now += 2;
    await s.search("Flamingo");
    expect(calls).toHaveLength(2);
  });

  test("session cap: default 200; at the cap no Google request is sent and the box says so", async () => {
    const store = new MemoryStore();
    const session = new MemoryStore();
    expect(readPlacesCap(store)).toBe(200);
    writePlacesCap(store, 2);
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({ store, session }, calls), { debounceMs: 1 });
    await s.search("Flamingo");
    await s.search("Key Largo");
    const third = await s.search("Homestead");
    expect(calls).toHaveLength(2);
    expect(placesUsed(session)).toBe(2);
    expect(third!.mode).toBe("capped");
    expect(third!.notice).toBe(CAPPED_MESSAGE);
    // Local places still come up at the cap.
    expect((await s.search("Flamingo"))!.provider).toBe("google"); // cached, no request
    expect(calls).toHaveLength(2);
  });

  test("cap setting: valid whole numbers only, saved from the Developer panel's form field", () => {
    const store = new MemoryStore();
    expect(writePlacesCap(store, 0)).toBe(200);
    expect(writePlacesCap(store, 1.5)).toBe(200);
    expect(writePlacesCap(store, 10_001)).toBe(200);
    expect(writePlacesCap(store, 350)).toBe(350);
    expect(store.getItem(PLACES_CAP_STORAGE_KEY)).toBe("350");
    const form = (v: string | null) => ({ has: (k: string) => k === "places-cap" && v !== null, get: () => v });
    expect(savePlacesCapField(store, form(null))).toBeNull();
    expect(savePlacesCapField(store, form("350"))).toBeNull();
    expect(savePlacesCapField(store, form("500"))).toBe("Place search cap set to 500 requests a session.");
    expect(savePlacesCapField(store, form("-3"))).toContain("whole number");
    expect(readPlacesCap(store)).toBe(500);
  });

  test("counting survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    writePlacesCap(new MemoryStore(), 1);
    expect(takePlacesRequests(broken, broken)).toBe(true);
    const store = new MemoryStore();
    store.setItem(PLACES_CAP_STORAGE_KEY, "1");
    expect(takePlacesRequests(store, broken)).toBe(false); // the in-memory count still holds the cap
    const session = new MemoryStore();
    session.setItem(PLACES_COUNT_STORAGE_KEY, "garbage");
    expect(placesUsed(session)).toBe(0);
  });

  test("no key: local gazetteer and Photon (keyless), never Google, and 'Search is limited without a Google key'", async () => {
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({ key: () => undefined }, calls), { debounceMs: 1 });
    const r = await s.search("Florida Bay");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith("https://photon.komoot.io/api/?")).toBe(true);
    expect(calls[0]!.init.method).toBe("GET");
    expect(JSON.stringify(calls[0]!.init.headers)).not.toContain("Goog");
    expect(r!.mode).toBe("keyless");
    expect(r!.provider).toBe("photon");
    expect(r!.notice).toBe(LIMITED_MESSAGE);
    expect(LIMITED_MESSAGE).toBe("Search is limited without a Google key");
    expect(r!.hits.map((h) => h.name)).toContain("Florida Bay");
    // A one-letter query stays local and still says why search is limited.
    const short = await s.search("F");
    expect(calls).toHaveLength(1);
    expect(short!.notice).toBe(LIMITED_MESSAGE);
  });

  test("a key but the Google 3D map capped (map not Google's): Photon, not Places, and no 'limited' notice", async () => {
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({ googleMap: () => false }, calls), { debounceMs: 1 });
    const r = await s.search("Flamingo");
    expect(calls[0]!.url).toContain("photon");
    expect(r!.notice).toBeNull();
  });

  test("an HTTP error keeps local hits and says what failed", async () => {
    const calls: Call[] = [];
    const s = createPlaceSearch(deps({ fetch: stubFetch(() => ({ error: { status: "PERMISSION_DENIED" } }), calls, { status: 403 }) }, calls), { debounceMs: 1 });
    const r = await s.search("Flamingo");
    expect(r!.error).toBe("Google search failed (HTTP 403 PERMISSION_DENIED).");
    expect(r!.hits.map((h) => h.source)).toEqual(["local"]);
  });

  test("origin override applies only in development and e2e builds, and only to a clean http(s) origin", () => {
    expect(overrideOrigin("http://127.0.0.1:4555/anything", true)).toBe("http://127.0.0.1:4555");
    expect(overrideOrigin("http://127.0.0.1:4555", false)).toBeNull();
    expect(overrideOrigin("javascript:alert(1)", true)).toBeNull();
    expect(overrideOrigin("not a url", true)).toBeNull();
    const store = new MemoryStore();
    expect(placesOrigins(store)).toEqual({ google: "https://places.googleapis.com", photon: "https://photon.komoot.io" });
    store.setItem(PLACES_BASE_STORAGE_KEY, "http://127.0.0.1:4555");
    // bun test runs with NODE_ENV=test: a test build honours it.
    expect(placesOrigins(store)).toEqual({ google: "http://127.0.0.1:4555", photon: "http://127.0.0.1:4555" });
  });

  test("flying: a viewport is framed, a point gets a town view, and seq is bumped", () => {
    const prev = viewFor(getApp("python"));
    const point = { id: "p", name: "Flamingo Visitor Center", address: "", lat: 25.1413, lon: -80.9243, viewport: null, source: "google" as const };
    expect(altitudeFor(point)).toBe(POINT_ALTITUDE_M);
    const v = viewForHit(prev, point);
    expect(v).toMatchObject({ lat: 25.1413, lon: -80.9243, pitch: -90, heading: 0, place: "Flamingo Visitor Center", seq: prev.seq + 1 });
    const bay = { ...point, viewport: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 } };
    expect(altitudeFor(bay)).toBeGreaterThan(POINT_ALTITUDE_M);
    expect(altitudeFor({ viewport: { west: -80.3, south: 25, east: -80.2999, north: 25.0001 } })).toBe(3_000);
  });
});

describe("nearby access", () => {
  const AT = { lat: 25.1417, lon: -80.9245 };
  const accessDeps = (over: Partial<SearchDeps> = {}, calls: Call[] = []) => deps(over, calls);

  test("two Places requests (Nearby marina + Text 'boat ramp'), merged nearest first, counted and cached", async () => {
    const calls: Call[] = [];
    const d = accessDeps({}, calls);
    const cache = new TtlCache<AccessPlace[]>();
    const r = await loadAccess(AT, d, undefined, cache);
    expect(calls.map((c) => c.url.split("/v1/")[1])).toEqual(["places:searchNearby", "places:searchText"]);
    expect(r.status).toBe("ok");
    const places = (r as { places: AccessPlace[] }).places;
    expect(places.map((p) => p.name)).toEqual(["Flamingo Marina", "Flamingo Boat Launch", "Snake Bight Boat Ramp"]);
    expect(placesUsed(d.session)).toBe(2);
    await loadAccess(AT, d, undefined, cache);
    expect(calls).toHaveLength(2);
  });

  test("no key: nothing is requested", async () => {
    const calls: Call[] = [];
    expect(await loadAccess(AT, accessDeps({ key: () => "" }, calls), undefined, new TtlCache())).toEqual({ status: "no-key" });
    expect(calls).toHaveLength(0);
  });

  test("a key but the Google map not in use (3D cap reached): nothing is requested", async () => {
    const calls: Call[] = [];
    expect(await loadAccess(AT, accessDeps({ googleMap: () => false }, calls), undefined, new TtlCache())).toEqual({ status: "no-map" });
    expect(calls).toHaveLength(0);
  });

  test("at the cap: nothing is requested", async () => {
    const store = new MemoryStore();
    writePlacesCap(store, 1);
    const calls: Call[] = [];
    expect(await loadAccess(AT, accessDeps({ store }, calls), undefined, new TtlCache())).toEqual({ status: "capped" });
    expect(calls).toHaveLength(0);
  });

  test("empty result", async () => {
    const calls: Call[] = [];
    const r = await loadAccess(AT, accessDeps({ fetch: stubFetch(() => ({}), calls) }, calls), undefined, new TtlCache());
    expect(r).toEqual({ status: "ok", places: [] });
    expect(NO_ACCESS_MESSAGE).toBe("No boat ramps found within 10 km");
  });
});
