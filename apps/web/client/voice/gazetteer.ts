/**
 * Small South Florida gazetteer for voice `fly_to { place }`. Pure data, shared by the relay
 * (to reject places it cannot resolve, so Grok retries with lat/lon) and the client handler.
 * Coordinates are approximate centers (visitor centers for park units), 4 decimals.
 */

export type Place = { name: string; lat: number; lon: number; altitudeM: number; aliases?: string[] };

const TOWN_M = 15_000;
const UNIT_M = 40_000;
const REGION_M = 90_000;

export const PLACES: readonly Place[] = [
  { name: "Flamingo", lat: 25.1417, lon: -80.9237, altitudeM: TOWN_M, aliases: ["flamingo visitor center", "flamingo marina"] },
  { name: "Everglades City", lat: 25.859, lon: -81.3862, altitudeM: TOWN_M, aliases: ["gulf coast visitor center"] },
  { name: "Chokoloskee", lat: 25.8126, lon: -81.3615, altitudeM: TOWN_M },
  { name: "Shark Valley", lat: 25.7573, lon: -80.7664, altitudeM: TOWN_M, aliases: ["shark valley visitor center"] },
  { name: "Ernest F. Coe Visitor Center", lat: 25.3953, lon: -80.5832, altitudeM: TOWN_M, aliases: ["coe visitor center", "main park entrance"] },
  { name: "Royal Palm", lat: 25.3827, lon: -80.6093, altitudeM: TOWN_M, aliases: ["anhinga trail", "royal palm visitor center"] },
  { name: "Long Pine Key", lat: 25.404, lon: -80.657, altitudeM: TOWN_M },
  { name: "Cape Sable", lat: 25.125, lon: -81.09, altitudeM: UNIT_M },
  { name: "Florida Bay", lat: 25.05, lon: -80.75, altitudeM: REGION_M },
  { name: "Ten Thousand Islands", lat: 25.85, lon: -81.55, altitudeM: UNIT_M },
  { name: "Everglades National Park", lat: 25.3, lon: -80.85, altitudeM: 160_000, aliases: ["everglades", "the park"] },
  { name: "Big Cypress", lat: 25.857, lon: -81.033, altitudeM: REGION_M, aliases: ["big cypress national preserve", "oasis visitor center"] },
  { name: "Biscayne National Park", lat: 25.464, lon: -80.3346, altitudeM: UNIT_M, aliases: ["biscayne", "convoy point"] },
  { name: "Homestead", lat: 25.4687, lon: -80.4776, altitudeM: TOWN_M },
  { name: "Florida City", lat: 25.4479, lon: -80.4792, altitudeM: TOWN_M },
  { name: "Miami", lat: 25.7617, lon: -80.1918, altitudeM: UNIT_M },
  { name: "Fort Lauderdale", lat: 26.1224, lon: -80.1373, altitudeM: UNIT_M },
  { name: "Naples", lat: 26.142, lon: -81.7948, altitudeM: UNIT_M },
  { name: "Marco Island", lat: 25.9412, lon: -81.7184, altitudeM: TOWN_M },
  { name: "Lake Okeechobee", lat: 26.95, lon: -80.8, altitudeM: 120_000, aliases: ["okeechobee"] },
  { name: "Key Largo", lat: 25.0865, lon: -80.4473, altitudeM: TOWN_M },
  { name: "Islamorada", lat: 24.9243, lon: -80.6278, altitudeM: TOWN_M },
  { name: "Marathon", lat: 24.7136, lon: -81.0904, altitudeM: TOWN_M },
  { name: "Big Pine Key", lat: 24.6693, lon: -81.354, altitudeM: TOWN_M },
  { name: "Key West", lat: 24.5551, lon: -81.78, altitudeM: TOWN_M },
  { name: "Dry Tortugas", lat: 24.6285, lon: -82.8732, altitudeM: UNIT_M, aliases: ["fort jefferson"] },
  { name: "Florida Keys", lat: 24.85, lon: -80.9, altitudeM: 200_000, aliases: ["the keys", "keys"] },
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const INDEX = new Map<string, Place>();
for (const place of PLACES) {
  INDEX.set(normalize(place.name), place);
  for (const alias of place.aliases ?? []) INDEX.set(normalize(alias), place);
}

/** Exact (normalized) match on a name or alias; also tolerates a trailing ", FL" / "Florida". */
export function resolvePlace(name: string): Place | null {
  const key = normalize(name);
  if (!key) return null;
  const direct = INDEX.get(key);
  if (direct) return direct;
  const stripped = key.replace(/\s+(fl|florida)$/, "");
  return INDEX.get(stripped) ?? null;
}
