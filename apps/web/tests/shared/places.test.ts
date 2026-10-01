import { describe, expect, test } from "bun:test";

import {
  ACCESS_FIELD_MASK,
  boxAround,
  formatKm,
  haversineKm,
  languageCode,
  localMatches,
  mapsPlaceUrl,
  mergeAccess,
  mergeHits,
  nearbyMarinasRequest,
  parseAccess,
  parsePhoton,
  parseTextSearch,
  photonRequest,
  rampSearchRequest,
  SEARCH_FIELD_MASK,
  textSearchRequest,
} from "shared/places";
import { appBBox, getApp } from "shared/apps";

import nearbyFixture from "../fixtures/places/nearby-marinas.json";
import photonFixture from "../fixtures/places/photon.json";
import rampFixture from "../fixtures/places/ramp-search.json";
import textFixture from "../fixtures/places/text-search.json";

/** Not a key: a placeholder that only proves the header is where the key goes. */
const KEY = "test-placeholder";
const PYTHON_BOX = appBBox(getApp("python"));
const FLAMINGO = { lat: 25.1417, lon: -80.9245 };

describe("place search", () => {
  test("text search request: POST with the key and a minimal field mask in headers, bias to the app box, language", () => {
    const req = textSearchRequest("  Flamingo ", PYTHON_BOX, { key: KEY, language: "en-US" });
    expect(req.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(req.method).toBe("POST");
    expect(req.url).not.toContain(KEY);
    expect(req.headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(req.headers["X-Goog-FieldMask"]).toBe(SEARCH_FIELD_MASK);
    // Only the id (Essentials) and Pro fields; nothing billed at Enterprise.
    expect(SEARCH_FIELD_MASK.split(",")).toEqual(["places.id", "places.displayName", "places.formattedAddress", "places.location", "places.viewport"]);
    const body = JSON.parse(req.body!);
    expect(body).toEqual({
      textQuery: "Flamingo",
      languageCode: "en",
      pageSize: 8,
      locationBias: { rectangle: { low: { latitude: PYTHON_BOX.south, longitude: PYTHON_BOX.west }, high: { latitude: PYTHON_BOX.north, longitude: PYTHON_BOX.east } } },
    });
  });

  test("text search request: origin override (e2e stub) and language fallbacks", () => {
    expect(textSearchRequest("x", PYTHON_BOX, { key: KEY, language: "es-MX", origin: "http://127.0.0.1:9" }).url).toBe("http://127.0.0.1:9/v1/places:searchText");
    expect(languageCode("es-MX")).toBe("es");
    expect(languageCode("")).toBe("en");
    expect(languageCode("*")).toBe("en");
  });

  test("text search response: hits with and without a viewport; entries without a location are dropped", () => {
    const hits = parseTextSearch(textFixture);
    expect(hits.map((h) => h.id)).toEqual(["fixture-place-flamingo", "fixture-place-flamingo-visitor-center", "fixture-place-flamingo-gardens"]);
    expect(hits[0]).toEqual({
      id: "fixture-place-flamingo",
      name: "Flamingo",
      address: "Flamingo, FL 33034, USA",
      lat: 25.1418871,
      lon: -80.9252637,
      viewport: { west: -80.9603, south: 25.1201, east: -80.8901, north: 25.1632 },
      source: "google",
    });
    expect(hits[1]!.viewport).toBeNull();
    expect(parseTextSearch({})).toEqual([]);
    expect(parseTextSearch(null)).toEqual([]);
    expect(parseTextSearch({ places: "nope" })).toEqual([]);
  });

  test("photon request: keyless GET restricted to the app box, page size, language", () => {
    const req = photonRequest("Flamingo", PYTHON_BOX, { language: "en-US" });
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://photon.komoot.io/api/");
    expect(url.searchParams.get("q")).toBe("Flamingo");
    expect(url.searchParams.get("limit")).toBe("8");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("bbox")).toBe([PYTHON_BOX.west, PYTHON_BOX.south, PYTHON_BOX.east, PYTHON_BOX.north].join(","));
    expect(req.headers).toEqual({});
    expect(new URL(photonRequest("x", PYTHON_BOX, { language: "es" }).url).searchParams.get("lang")).toBe("default");
  });

  test("photon response: points, extents as viewports, nameless features dropped", () => {
    const hits = parsePhoton(photonFixture);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "osm:N154353700", name: "Flamingo", address: "Monroe County, Florida, United States", viewport: null, source: "photon" });
    expect(hits[1]!.viewport).toEqual({ west: -81.1, south: 24.85, east: -80.35, north: 25.25 });
  });

  test("local gazetteer: exact before prefix before word prefix, limited to the box", () => {
    const places = [
      { name: "Flamingo", lat: 25.14, lon: -80.92 },
      { name: "Flamingo City", lat: 25.2, lon: -80.5 },
      { name: "West Flamingo", lat: 25.3, lon: -80.6 },
      { name: "Flamingo Far", lat: 40, lon: -75 },
      { name: "Key West", lat: 24.55, lon: -81.78, aliases: ["kw"] },
    ];
    expect(localMatches("flamingo", places, PYTHON_BOX).map((h) => h.name)).toEqual(["Flamingo", "Flamingo City", "West Flamingo"]);
    expect(localMatches("KW", places, null).map((h) => h.name)).toEqual(["Key West"]);
    expect(localMatches("f", places, null)).toEqual([]);
    expect(localMatches("Flamingo", places, null)[0]).toMatchObject({ id: "local:Flamingo", source: "local", viewport: null });
  });

  test("merge: local first, a remote duplicate of a local place dropped", () => {
    const local = localMatches("flamingo", [{ name: "Flamingo", lat: 25.1418, lon: -80.9252 }], null);
    const merged = mergeHits(local, parseTextSearch(textFixture));
    expect(merged.map((h) => h.id)).toEqual(["local:Flamingo", "fixture-place-flamingo-visitor-center", "fixture-place-flamingo-gardens"]);
  });
});

describe("nearby access", () => {
  test("nearby request: marina (a Table A type) within 10 km, nearest first, minimal field mask", () => {
    const req = nearbyMarinasRequest(FLAMINGO, { key: KEY, language: "en" });
    expect(req.url).toBe("https://places.googleapis.com/v1/places:searchNearby");
    expect(req.headers["X-Goog-FieldMask"]).toBe(ACCESS_FIELD_MASK);
    expect(req.headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(JSON.parse(req.body!)).toEqual({
      includedTypes: ["marina"],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      languageCode: "en",
      locationRestriction: { circle: { center: { latitude: FLAMINGO.lat, longitude: FLAMINGO.lon }, radius: 10_000 } },
    });
  });

  test("ramp request: Text Search 'boat ramp' restricted to the box around the 10 km circle", () => {
    const body = JSON.parse(rampSearchRequest(FLAMINGO, { key: KEY, language: "en" }).body!);
    expect(body.textQuery).toBe("boat ramp");
    const r = body.locationRestriction.rectangle;
    const box = boxAround(FLAMINGO, 10);
    expect(r).toEqual({ low: { latitude: box.south, longitude: box.west }, high: { latitude: box.north, longitude: box.east } });
    // The box's edges are 10 km from the centre.
    expect(haversineKm(FLAMINGO, { lat: box.north, lon: FLAMINGO.lon })).toBeCloseTo(10, 1);
    expect(haversineKm(FLAMINGO, { lat: FLAMINGO.lat, lon: box.east })).toBeCloseTo(10, 1);
  });

  test("parse and merge: one entry per place, within 10 km, sorted by distance, labelled marina or ramp", () => {
    const merged = mergeAccess([parseAccess(nearbyFixture, FLAMINGO, "marina"), parseAccess(rampFixture, FLAMINGO, "ramp")]);
    expect(merged.map((p) => p.id)).toEqual(["fixture-marina-flamingo", "fixture-launch-flamingo", "fixture-ramp-snake-bight"]);
    expect(merged.map((p) => p.kind)).toEqual(["marina", "ramp", "ramp"]);
    for (let i = 1; i < merged.length; i++) expect(merged[i]!.km).toBeGreaterThanOrEqual(merged[i - 1]!.km);
    expect(merged.every((p) => p.km <= 10)).toBe(true);
    // The far marina (about 17 km) is left out.
    expect(parseAccess(nearbyFixture, FLAMINGO, "marina").find((p) => p.id === "fixture-marina-far")!.km).toBeGreaterThan(10);
    expect(mergeAccess([parseAccess({}, FLAMINGO, "marina")])).toEqual([]);
  });

  test("Open in Google Maps: an https Maps URL built from the place id", () => {
    const url = new URL(mapsPlaceUrl("fixture-marina-flamingo", "Flamingo Marina"));
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("www.google.com");
    expect(url.pathname).toBe("/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("query")).toBe("Flamingo Marina");
    expect(url.searchParams.get("query_place_id")).toBe("fixture-marina-flamingo");
  });

  test("distance text", () => {
    expect(formatKm(0.0734)).toBe("70 m");
    expect(formatKm(0.004)).toBe("10 m");
    expect(formatKm(2.345)).toBe("2.3 km");
    expect(formatKm(12.6)).toBe("13 km");
  });
});
