/**
 * Local gazetteer for South Florida field names that generic geocoders get
 * wrong or miss (park units, sloughs, reef tracts, marinas). Checked before
 * Open-Meteo. Coordinates are WGS84; area bboxes are hand-drawn and generous.
 */

import { REGION_BBOX } from "@/server/agent/config";
import type { BBox } from "@/shared/agent/events";

export type Place = {
  name: string;
  kind: "park" | "unit" | "water" | "reef" | "town" | "marina" | "trail";
  lat: number;
  lon: number;
  bbox: BBox;
  source: "gazetteer" | "open-meteo";
};

type Row = { name: string; aliases?: string[]; kind: Place["kind"]; lat: number; lon: number; bbox?: BBox; half?: number };

const ROWS: Row[] = [
  // Everglades National Park and its units.
  { name: "Everglades National Park", aliases: ["everglades", "enp", "the glades"], kind: "park", lat: 25.29, lon: -80.9, bbox: { west: -81.4, south: 24.95, east: -80.4, north: 25.9 } },
  { name: "Flamingo", aliases: ["flamingo visitor center", "flamingo marina"], kind: "unit", lat: 25.1417, lon: -80.9245 },
  { name: "Shark Valley", aliases: ["shark valley visitor center", "shark valley tram road"], kind: "unit", lat: 25.7571, lon: -80.7665 },
  { name: "Shark River Slough", aliases: ["shark slough"], kind: "water", lat: 25.55, lon: -80.8, bbox: { west: -81.0, south: 25.35, east: -80.6, north: 25.78 } },
  { name: "Taylor Slough", kind: "water", lat: 25.4, lon: -80.62, bbox: { west: -80.7, south: 25.2, east: -80.55, north: 25.5 } },
  { name: "Royal Palm", aliases: ["anhinga trail", "royal palm visitor center"], kind: "trail", lat: 25.3826, lon: -80.6093 },
  { name: "Ernest F. Coe Visitor Center", aliases: ["coe visitor center", "main park road", "homestead entrance"], kind: "unit", lat: 25.3949, lon: -80.583 },
  { name: "Mahogany Hammock", kind: "trail", lat: 25.3237, lon: -80.8318 },
  { name: "Pa-hay-okee Overlook", aliases: ["pahayokee"], kind: "trail", lat: 25.4406, lon: -80.7837 },
  { name: "West Lake", kind: "water", lat: 25.2106, lon: -80.8453 },
  { name: "Gulf Coast Visitor Center", aliases: ["everglades city"], kind: "town", lat: 25.8457, lon: -81.3867 },
  { name: "Chokoloskee", aliases: ["chokoloskee island", "chokoloskee bay"], kind: "town", lat: 25.8126, lon: -81.362 },
  { name: "Ten Thousand Islands", kind: "water", lat: 25.85, lon: -81.55, bbox: { west: -81.75, south: 25.7, east: -81.3, north: 25.95 } },
  { name: "Florida Bay", kind: "water", lat: 25.05, lon: -80.75, bbox: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 } },
  { name: "Frog Pond", aliases: ["southern glades", "southern glades wildlife area"], kind: "unit", lat: 25.4, lon: -80.55 },
  // Big Cypress and the Water Conservation Areas.
  { name: "Big Cypress National Preserve", aliases: ["big cypress"], kind: "park", lat: 25.86, lon: -81.03, bbox: { west: -81.45, south: 25.75, east: -80.8, north: 26.35 } },
  { name: "Tamiami Trail", aliases: ["us-41", "us 41"], kind: "trail", lat: 25.76, lon: -80.8, bbox: { west: -81.3, south: 25.72, east: -80.45, north: 25.8 } },
  { name: "Water Conservation Area 3A", aliases: ["wca 3a", "wca3a", "wca-3a"], kind: "unit", lat: 26.0, lon: -80.7, bbox: { west: -80.85, south: 25.75, east: -80.45, north: 26.35 } },
  { name: "Water Conservation Area 3B", aliases: ["wca 3b", "wca3b", "wca-3b"], kind: "unit", lat: 25.85, lon: -80.5, bbox: { west: -80.6, south: 25.75, east: -80.4, north: 25.98 } },
  { name: "Water Conservation Area 2", aliases: ["wca 2", "wca2", "wca-2"], kind: "unit", lat: 26.2, lon: -80.35, bbox: { west: -80.5, south: 26.05, east: -80.25, north: 26.35 } },
  { name: "Arthur R. Marshall Loxahatchee National Wildlife Refuge", aliases: ["loxahatchee", "wca 1", "lox refuge"], kind: "park", lat: 26.5, lon: -80.3, bbox: { west: -80.45, south: 26.35, east: -80.15, north: 26.7 } },
  { name: "Fakahatchee Strand", aliases: ["fakahatchee strand preserve state park"], kind: "park", lat: 25.95, lon: -81.4, bbox: { west: -81.5, south: 25.85, east: -81.3, north: 26.15 } },
  { name: "Collier-Seminole State Park", aliases: ["collier seminole"], kind: "park", lat: 25.99, lon: -81.59 },
  { name: "Everglades Holiday Park", aliases: ["holiday park"], kind: "marina", lat: 26.0592, lon: -80.4439 },
  { name: "Lake Okeechobee", aliases: ["okeechobee", "lake o"], kind: "water", lat: 26.95, lon: -80.83, bbox: { west: -81.12, south: 26.68, east: -80.6, north: 27.2 } },
  // Biscayne and the Keys.
  { name: "Biscayne Bay", aliases: ["biscayne"], kind: "water", lat: 25.6, lon: -80.22, bbox: { west: -80.35, south: 25.35, east: -80.05, north: 25.9 } },
  { name: "Biscayne National Park", aliases: ["bnp", "elliott key"], kind: "park", lat: 25.48, lon: -80.21, bbox: { west: -80.35, south: 25.3, east: -80.05, north: 25.65 } },
  { name: "Card Sound", kind: "water", lat: 25.29, lon: -80.37 },
  { name: "Turkey Point", kind: "town", lat: 25.435, lon: -80.33 },
  { name: "Crocodile Lake National Wildlife Refuge", aliases: ["crocodile lake"], kind: "park", lat: 25.27, lon: -80.4 },
  { name: "Key Largo", aliases: ["largo"], kind: "town", lat: 25.0865, lon: -80.4473, bbox: { west: -80.55, south: 24.97, east: -80.3, north: 25.3 } },
  { name: "John Pennekamp Coral Reef State Park", aliases: ["pennekamp", "john pennekamp"], kind: "reef", lat: 25.125, lon: -80.406, bbox: { west: -80.45, south: 24.95, east: -80.2, north: 25.3 } },
  { name: "Molasses Reef", kind: "reef", lat: 25.0104, lon: -80.3753 },
  { name: "Islamorada", kind: "town", lat: 24.9243, lon: -80.6278 },
  { name: "Alligator Reef", kind: "reef", lat: 24.8514, lon: -80.6189 },
  { name: "Marathon", aliases: ["marathon key"], kind: "town", lat: 24.7136, lon: -81.0904, bbox: { west: -81.2, south: 24.55, east: -80.95, north: 24.8 } },
  { name: "Sombrero Reef", aliases: ["sombrero key"], kind: "reef", lat: 24.6258, lon: -81.1105 },
  { name: "Big Pine Key", aliases: ["big pine"], kind: "town", lat: 24.6713, lon: -81.354 },
  { name: "Looe Key", aliases: ["looe key reef"], kind: "reef", lat: 24.546, lon: -81.406 },
  { name: "Key West", kind: "town", lat: 24.5551, lon: -81.78, bbox: { west: -81.85, south: 24.52, east: -81.7, north: 24.6 } },
  { name: "Dry Tortugas National Park", aliases: ["dry tortugas", "fort jefferson"], kind: "park", lat: 24.6285, lon: -82.8732, bbox: { west: -83.05, south: 24.55, east: -82.75, north: 24.75 } },
  // Mainland towns.
  { name: "Homestead", aliases: ["homestead air reserve base"], kind: "town", lat: 25.4687, lon: -80.4776, bbox: { west: -80.56, south: 25.38, east: -80.33, north: 25.56 } },
  { name: "Florida City", kind: "town", lat: 25.4479, lon: -80.4792 },
  { name: "Miami", kind: "town", lat: 25.7617, lon: -80.1918, bbox: { west: -80.32, south: 25.7, east: -80.12, north: 25.86 } },
  { name: "Miami Beach", kind: "town", lat: 25.7907, lon: -80.13 },
  { name: "Fort Lauderdale", kind: "town", lat: 26.1224, lon: -80.1373 },
  { name: "Naples", kind: "town", lat: 26.142, lon: -81.7948 },
  { name: "Marco Island", kind: "town", lat: 25.9412, lon: -81.7184 },
];

/** Point entries default to a ~9 km half-width box. */
const DEFAULT_HALF_DEG = 0.08;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\b(the|near|around|at|in)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toPlace(row: Row): Place {
  const half = row.half ?? DEFAULT_HALF_DEG;
  return {
    name: row.name,
    kind: row.kind,
    lat: row.lat,
    lon: row.lon,
    bbox: row.bbox ?? { west: row.lon - half, south: row.lat - half, east: row.lon + half, north: row.lat + half },
    source: "gazetteer",
  };
}

/** Exact name or alias first, then the longest name contained in the query. */
export function lookupGazetteer(query: string): Place | null {
  const q = normalize(query);
  if (!q) return null;
  const names = (row: Row) => [row.name, ...(row.aliases ?? [])].map(normalize);
  const exact = ROWS.find((row) => names(row).includes(q));
  if (exact) return toPlace(exact);
  let best: { row: Row; length: number } | null = null;
  for (const row of ROWS) {
    for (const name of names(row)) {
      const hit = name.length >= 4 && (q.includes(name) || (q.length >= 5 && name.includes(q)));
      if (hit && (!best || name.length > best.length)) best = { row, length: name.length };
    }
  }
  return best ? toPlace(best.row) : null;
}

export function inRegion(lat: number, lon: number): boolean {
  return lat >= REGION_BBOX.south && lat <= REGION_BBOX.north && lon >= REGION_BBOX.west && lon <= REGION_BBOX.east;
}

type OpenMeteoResult = { name: string; latitude: number; longitude: number; admin1?: string; feature_code?: string };

/** Open-Meteo geocoding, restricted to the operating region. */
export async function openMeteoGeocode(query: string, signal?: AbortSignal): Promise<Place | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  url.searchParams.set("countryCode", "US");
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`Open-Meteo geocoding HTTP ${response.status}`);
  const body = (await response.json()) as { results?: OpenMeteoResult[] };
  const hit = (body.results ?? []).find((row) => inRegion(row.latitude, row.longitude));
  if (!hit) return null;
  return {
    name: hit.admin1 ? `${hit.name}, ${hit.admin1}` : hit.name,
    kind: "town",
    lat: hit.latitude,
    lon: hit.longitude,
    bbox: {
      west: hit.longitude - DEFAULT_HALF_DEG,
      south: hit.latitude - DEFAULT_HALF_DEG,
      east: hit.longitude + DEFAULT_HALF_DEG,
      north: hit.latitude + DEFAULT_HALF_DEG,
    },
    source: "open-meteo",
  };
}
