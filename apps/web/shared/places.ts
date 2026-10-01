/**
 * Place search and nearby water access (docs/places.md, gates/leaf-GE6.md): request builders and response parsers
 * for Google Places API (New) Text Search and Nearby Search and for Photon (keyless, OpenStreetMap), plus the local
 * matcher and the distance maths. Pure: no fetch, no storage, so the rules are unit-tested against recorded
 * fixtures of the documented shapes.
 *
 * Why Places (New) and not the Geocoding web service: Geocoding answers CORS but refuses keys with website
 * (referrer) restrictions, and the one browser key here is referrer restricted; Places (New) answers the browser's
 * preflight for `X-Goog-Api-Key` and `X-Goog-FieldMask` and is meant for the Websites restriction (docs/places.md).
 */
import type { BBox } from "shared/agent/events";

export const PLACES_ORIGIN = "https://places.googleapis.com";
export const PHOTON_ORIGIN = "https://photon.komoot.io";
export const TEXT_SEARCH_PATH = "/v1/places:searchText";
export const NEARBY_SEARCH_PATH = "/v1/places:searchNearby";
export const PHOTON_PATH = "/api/";

/**
 * Text Search field mask: the id (Essentials) and four Pro fields. No Enterprise field (rating, hours, phone), so
 * a request bills at the Pro rate and nothing is fetched that the box does not show.
 */
export const SEARCH_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location,places.viewport";
/** Nearby and the ramp text query: the same, with `types` (to label marina vs ramp) instead of the viewport. */
export const ACCESS_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.location,places.types";

/** How far the access list looks from a sighting. */
export const ACCESS_RADIUS_M = 10_000;
/**
 * Places (New) Table A has `marina` but no boat ramp or boat launch type (place-types page, checked 2026-10-01), so
 * marinas come from Nearby Search by type and ramps from a Text Search restricted to the same area.
 */
export const ACCESS_TYPES = ["marina"] as const;
export const RAMP_QUERY = "boat ramp";
/** Results a search box shows. */
export const SEARCH_PAGE_SIZE = 8;

export type PlaceSource = "google" | "photon" | "local";

export type PlaceHit = {
  /** Google place id, `osm:<type><id>` for Photon, `local:<name>` for the gazetteer. */
  id: string;
  name: string;
  /** One line under the name (address, or town and state); may be empty. */
  address: string;
  lat: number;
  lon: number;
  /** The area to frame when the place has one (a park, a bay); null for a point. */
  viewport: BBox | null;
  source: PlaceSource;
};

export type AccessKind = "marina" | "ramp";

export type AccessPlace = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** Great-circle distance from the sighting, km. */
  km: number;
  kind: AccessKind;
};

/** A request ready for `fetch`. The key travels in a header, never in the URL. */
export type HttpRequest = { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string };

export type LatLon = { lat: number; lon: number };

// ---- geometry -------------------------------------------------------------------------------------------

const EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The box that holds a circle of `km` around a point (for a rectangle-only restriction). */
export function boxAround(at: LatLon, km: number): BBox {
  const dLat = km / 111.32;
  const dLon = Math.min(180, dLat / Math.max(0.01, Math.cos(rad(at.lat))));
  return { west: Math.max(-180, at.lon - dLon), south: Math.max(-90, at.lat - dLat), east: Math.min(180, at.lon + dLon), north: Math.min(90, at.lat + dLat) };
}

const rectangle = (b: BBox) => ({ low: { latitude: b.south, longitude: b.west }, high: { latitude: b.north, longitude: b.east } });

// ---- Google Places API (New) ----------------------------------------------------------------------------

export type GoogleOpts = { key: string; language: string; origin?: string };

function googleRequest(path: string, mask: string, body: object, o: GoogleOpts): HttpRequest {
  return {
    url: `${o.origin ?? PLACES_ORIGIN}${path}`,
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": o.key, "X-Goog-FieldMask": mask },
    body: JSON.stringify(body),
  };
}

/** BCP-47 language for Google (`en-US` → `en`); Google defaults to `en` on an empty one, so fall back to it. */
export function languageCode(language: string | undefined): string {
  const primary = (language ?? "").trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(primary) ? primary : "en";
}

/** Text Search for the search box: biased (not restricted) to the app's box, so a famous place elsewhere still comes up. */
export function textSearchRequest(query: string, bias: BBox, o: GoogleOpts): HttpRequest {
  return googleRequest(TEXT_SEARCH_PATH, SEARCH_FIELD_MASK, { textQuery: query.trim(), languageCode: languageCode(o.language), pageSize: SEARCH_PAGE_SIZE, locationBias: { rectangle: rectangle(bias) } }, o);
}

/** Nearby Search for marinas within `radiusM` of a sighting, nearest first. */
export function nearbyMarinasRequest(at: LatLon, o: GoogleOpts, radiusM = ACCESS_RADIUS_M): HttpRequest {
  return googleRequest(
    NEARBY_SEARCH_PATH,
    ACCESS_FIELD_MASK,
    {
      includedTypes: [...ACCESS_TYPES],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      languageCode: languageCode(o.language),
      locationRestriction: { circle: { center: { latitude: at.lat, longitude: at.lon }, radius: radiusM } },
    },
    o,
  );
}

/** Text Search for boat ramps and launches, restricted to the box around the circle (the circle is applied after). */
export function rampSearchRequest(at: LatLon, o: GoogleOpts, radiusM = ACCESS_RADIUS_M): HttpRequest {
  return googleRequest(
    TEXT_SEARCH_PATH,
    ACCESS_FIELD_MASK,
    { textQuery: RAMP_QUERY, languageCode: languageCode(o.language), pageSize: 20, locationRestriction: { rectangle: rectangle(boxAround(at, radiusM / 1000)) } },
    o,
  );
}

type GooglePlace = {
  id?: unknown;
  displayName?: { text?: unknown };
  formattedAddress?: unknown;
  location?: { latitude?: unknown; longitude?: unknown };
  viewport?: { low?: { latitude?: unknown; longitude?: unknown }; high?: { latitude?: unknown; longitude?: unknown } };
  types?: unknown;
};

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function placesOf(json: unknown): GooglePlace[] {
  const list = (json as { places?: unknown } | null)?.places;
  return Array.isArray(list) ? (list as GooglePlace[]) : [];
}

function viewportOf(p: GooglePlace): BBox | null {
  const s = finite(p.viewport?.low?.latitude);
  const w = finite(p.viewport?.low?.longitude);
  const n = finite(p.viewport?.high?.latitude);
  const e = finite(p.viewport?.high?.longitude);
  if (s === null || w === null || n === null || e === null || n <= s || e <= w) return null;
  return { west: w, south: s, east: e, north: n };
}

/** Text Search response → hits; entries without an id, a name or a location are dropped. */
export function parseTextSearch(json: unknown): PlaceHit[] {
  const out: PlaceHit[] = [];
  for (const p of placesOf(json)) {
    const id = text(p.id);
    const name = text(p.displayName?.text);
    const lat = finite(p.location?.latitude);
    const lon = finite(p.location?.longitude);
    if (!id || !name || lat === null || lon === null) continue;
    out.push({ id, name, address: text(p.formattedAddress), lat, lon, viewport: viewportOf(p), source: "google" });
  }
  return out;
}

/** Nearby or ramp response → access places with their distance from `at`; `fallback` labels a place without a marina type. */
export function parseAccess(json: unknown, at: LatLon, fallback: AccessKind): AccessPlace[] {
  const out: AccessPlace[] = [];
  for (const p of placesOf(json)) {
    const id = text(p.id);
    const name = text(p.displayName?.text);
    const lat = finite(p.location?.latitude);
    const lon = finite(p.location?.longitude);
    if (!id || !name || lat === null || lon === null) continue;
    const types = Array.isArray(p.types) ? p.types : [];
    const kind: AccessKind = types.includes("marina") ? "marina" : /\b(ramp|launch|landing)\b/i.test(name) ? "ramp" : fallback;
    out.push({ id, name, address: text(p.formattedAddress), lat, lon, km: haversineKm(at, { lat, lon }), kind });
  }
  return out;
}

/** One list from several responses: one entry per place id, only within `maxKm`, nearest first. */
export function mergeAccess(lists: readonly AccessPlace[][], maxKm = ACCESS_RADIUS_M / 1000): AccessPlace[] {
  const byId = new Map<string, AccessPlace>();
  for (const p of lists.flat()) if (p.km <= maxKm && !byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => a.km - b.km || a.name.localeCompare(b.name));
}

/**
 * "Open in Google Maps" for a place id (Maps URLs, `api=1`): the name as the query and the id to pin the exact
 * place. https only; opens in a new tab through `ExternalLink`.
 */
export function mapsPlaceUrl(placeId: string, name: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(placeId)}`;
}

/** "450 m", "2.3 km", "12 km". */
export function formatKm(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

// ---- Photon (keyless, OpenStreetMap) --------------------------------------------------------------------

/** Languages the public Photon instance serves; anything else gets the local name (`default`). */
const PHOTON_LANGS = new Set(["en", "de", "fr", "it"]);

/** Photon search restricted to the app's box (`bbox=minLon,minLat,maxLon,maxLat`). */
export function photonRequest(query: string, box: BBox, o: { language: string; origin?: string }): HttpRequest {
  const lang = languageCode(o.language);
  const params = new URLSearchParams({ q: query.trim(), limit: String(SEARCH_PAGE_SIZE), lang: PHOTON_LANGS.has(lang) ? lang : "default", bbox: [box.west, box.south, box.east, box.north].join(",") });
  return { url: `${o.origin ?? PHOTON_ORIGIN}${PHOTON_PATH}?${params}`, method: "GET", headers: {} };
}

type PhotonFeature = {
  geometry?: { coordinates?: unknown };
  properties?: { osm_type?: unknown; osm_id?: unknown; name?: unknown; city?: unknown; county?: unknown; state?: unknown; country?: unknown; extent?: unknown };
};

/** Photon GeoJSON → hits; `extent` is `[minLon, maxLat, maxLon, minLat]`. */
export function parsePhoton(json: unknown): PlaceHit[] {
  const features = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: PlaceHit[] = [];
  for (const f of features as PhotonFeature[]) {
    const c = Array.isArray(f.geometry?.coordinates) ? (f.geometry!.coordinates as unknown[]) : [];
    const lon = finite(c[0]);
    const lat = finite(c[1]);
    const p = f.properties ?? {};
    const name = text(p.name);
    if (lat === null || lon === null || !name) continue;
    const ex = Array.isArray(p.extent) ? (p.extent as unknown[]).map(finite) : [];
    const [w, n, e, s] = ex;
    const viewport = ex.length === 4 && w != null && n != null && e != null && s != null && n > s && e > w ? { west: w, south: s, east: e, north: n } : null;
    const address = [text(p.city) || text(p.county), text(p.state), text(p.country)].filter((part, i, all) => part && part !== name && all.indexOf(part) === i).join(", ");
    out.push({ id: `osm:${text(p.osm_type)}${String(p.osm_id ?? "")}`, name, address, lat, lon, viewport, source: "photon" });
  }
  return out;
}

// ---- local gazetteer ------------------------------------------------------------------------------------

export type LocalPlace = { name: string; lat: number; lon: number; aliases?: readonly string[] };

export function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Gazetteer names that match: exact first, then prefix, then a word prefix; inside `within` when given. */
export function localMatches(query: string, places: readonly LocalPlace[], within: BBox | null, limit = 5): PlaceHit[] {
  const q = normalizeQuery(query);
  if (q.length < 2) return [];
  const scored: { p: LocalPlace; score: number }[] = [];
  for (const p of places) {
    if (within && !(p.lat >= within.south && p.lat <= within.north && p.lon >= within.west && p.lon <= within.east)) continue;
    let best = 0;
    for (const n of [p.name, ...(p.aliases ?? [])].map(normalizeQuery)) {
      const s = n === q ? 3 : n.startsWith(q) ? 2 : n.split(" ").some((w) => w.startsWith(q)) || (q.length >= 4 && n.includes(q)) ? 1 : 0;
      best = Math.max(best, s);
    }
    if (best > 0) scored.push({ p, score: best });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map(({ p }) => ({ id: `local:${p.name}`, name: p.name, address: "", lat: p.lat, lon: p.lon, viewport: null, source: "local" as const }));
}

/** Local hits first, then remote ones not within ~300 m of a local hit with the same name. */
export function mergeHits(local: readonly PlaceHit[], remote: readonly PlaceHit[], limit = SEARCH_PAGE_SIZE): PlaceHit[] {
  const out = [...local];
  for (const r of remote) {
    if (out.some((h) => normalizeQuery(h.name) === normalizeQuery(r.name) && haversineKm(h, r) < 0.3)) continue;
    out.push(r);
  }
  return out.slice(0, limit);
}
