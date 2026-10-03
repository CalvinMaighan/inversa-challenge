/**
 * Small South Florida gazetteer for voice `fly_to { place }`. Pure data, shared by the relay
 * (to reject places it cannot resolve, so Grok retries with lat/lon) and the client handler.
 * Coordinates are approximate centers (visitor centers for park units), 4 decimals.
 */

export type Place = { name: string; lat: number; lon: number; altitudeM: number; aliases?: string[] };

const TOWN_M = 15_000;
const UNIT_M = 40_000;
const REGION_M = 90_000;
/** Cities and river towns of the Mississippi River Basin, and reef towns of the Caribbean areas. */
const RIVER_M = 60_000;
const REEF_M = 120_000;

export const PLACES: readonly Place[] = [
  // Mississippi River Basin (carp)
  { name: "St. Louis", lat: 38.627, lon: -90.1994, altitudeM: RIVER_M, aliases: ["saint louis", "st louis"] },
  { name: "Memphis", lat: 35.1495, lon: -90.049, altitudeM: RIVER_M },
  { name: "Vicksburg", lat: 32.3526, lon: -90.8779, altitudeM: RIVER_M },
  { name: "Natchez", lat: 31.5604, lon: -91.4032, altitudeM: RIVER_M },
  { name: "Baton Rouge", lat: 30.4515, lon: -91.1871, altitudeM: RIVER_M },
  { name: "New Orleans", lat: 29.9511, lon: -90.0715, altitudeM: RIVER_M },
  { name: "Morgan City", lat: 29.6994, lon: -91.2068, altitudeM: RIVER_M },
  { name: "Cairo", lat: 37.0053, lon: -89.1765, altitudeM: RIVER_M, aliases: ["cairo illinois", "where the ohio meets the mississippi"] },
  { name: "Cape Girardeau", lat: 37.3059, lon: -89.5181, altitudeM: RIVER_M },
  { name: "Chester", lat: 37.9017, lon: -89.8221, altitudeM: RIVER_M, aliases: ["chester illinois"] },
  { name: "Grafton", lat: 38.9687, lon: -90.4293, altitudeM: RIVER_M, aliases: ["grafton illinois", "the illinois river mouth"] },
  { name: "Keokuk", lat: 40.3964, lon: -91.3849, altitudeM: RIVER_M },
  { name: "Clinton", lat: 41.8445, lon: -90.1887, altitudeM: RIVER_M, aliases: ["clinton iowa"] },
  { name: "Davenport", lat: 41.5236, lon: -90.5776, altitudeM: RIVER_M, aliases: ["quad cities"] },
  { name: "St. Paul", lat: 44.9537, lon: -93.09, altitudeM: RIVER_M, aliases: ["saint paul", "st paul", "minneapolis", "twin cities"] },
  { name: "Louisville", lat: 38.2527, lon: -85.7585, altitudeM: RIVER_M, aliases: ["the ohio river at louisville"] },
  { name: "Kansas City", lat: 39.0997, lon: -94.5786, altitudeM: RIVER_M, aliases: ["the missouri river"] },
  { name: "Chicago", lat: 41.8781, lon: -87.6298, altitudeM: RIVER_M, aliases: ["the chicago canal", "chicago sanitary canal", "the carp barrier"] },
  { name: "Atchafalaya Basin", lat: 30.35, lon: -91.55, altitudeM: 180_000, aliases: ["atchafalaya", "the atchafalaya"] },
  { name: "Mississippi River Basin", lat: 38, lon: -89.5, altitudeM: 2_400_000, aliases: ["the mississippi", "the basin", "mississippi river", "mississippi"] },
  // Caribbean areas (lionfish)
  { name: "Florida Keys", lat: 24.75, lon: -81.0, altitudeM: 250_000, aliases: ["the keys", "keys"] },
  { name: "Key West", lat: 24.5551, lon: -81.78, altitudeM: UNIT_M },
  { name: "Key Largo", lat: 25.0865, lon: -80.4473, altitudeM: UNIT_M },
  { name: "Marathon", lat: 24.7137, lon: -81.0901, altitudeM: UNIT_M },
  { name: "Cancun", lat: 21.1619, lon: -86.8515, altitudeM: REEF_M, aliases: ["cancún"] },
  { name: "Cozumel", lat: 20.4318, lon: -86.9203, altitudeM: REEF_M },
  { name: "Playa del Carmen", lat: 20.6296, lon: -87.0739, altitudeM: REEF_M },
  { name: "Tulum", lat: 20.2114, lon: -87.4654, altitudeM: REEF_M },
  { name: "Mexican Caribbean", lat: 20.0, lon: -87.2, altitudeM: 420_000, aliases: ["the mexican caribbean", "quintana roo", "riviera maya"] },
  { name: "Belize", lat: 17.1, lon: -87.9, altitudeM: 320_000, aliases: ["the belize reef", "belize barrier reef"] },
  { name: "Belize City", lat: 17.4995, lon: -88.1976, altitudeM: REEF_M },
  { name: "Ambergris Caye", lat: 17.9, lon: -87.96, altitudeM: REEF_M, aliases: ["san pedro belize"] },
  { name: "Placencia", lat: 16.5146, lon: -88.3661, altitudeM: REEF_M },
  { name: "Colombian Caribbean", lat: 11.6, lon: -77.9, altitudeM: 900_000, aliases: ["colombia", "the colombian caribbean"] },
  { name: "Cartagena", lat: 10.391, lon: -75.4794, altitudeM: REEF_M },
  { name: "Santa Marta", lat: 11.2408, lon: -74.199, altitudeM: REEF_M },
  { name: "San Andres", lat: 12.5847, lon: -81.7006, altitudeM: REEF_M, aliases: ["san andrés", "providencia"] },
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
  { name: "Downtown Miami", lat: 25.7743, lon: -80.1937, altitudeM: TOWN_M },
  { name: "Coral Gables", lat: 25.7215, lon: -80.2684, altitudeM: TOWN_M },
  { name: "Coconut Grove", lat: 25.7126, lon: -80.2573, altitudeM: TOWN_M },
  { name: "Key Biscayne", lat: 25.6938, lon: -80.1628, altitudeM: TOWN_M },
  { name: "Hialeah", lat: 25.8576, lon: -80.2781, altitudeM: TOWN_M },
  { name: "Doral", lat: 25.8195, lon: -80.3553, altitudeM: TOWN_M },
  { name: "Kendall", lat: 25.6793, lon: -80.3173, altitudeM: TOWN_M },
  { name: "Pinecrest", lat: 25.6671, lon: -80.3081, altitudeM: TOWN_M },
  { name: "Palmetto Bay", lat: 25.6218, lon: -80.3245, altitudeM: TOWN_M },
  { name: "Cutler Bay", lat: 25.5808, lon: -80.3468, altitudeM: TOWN_M },
  { name: "Miami Beach", lat: 25.7907, lon: -80.13, altitudeM: TOWN_M },
  { name: "Hollywood", lat: 26.0112, lon: -80.1495, altitudeM: TOWN_M },
  { name: "Pembroke Pines", lat: 26.0078, lon: -80.2963, altitudeM: TOWN_M },
  { name: "Weston", lat: 26.1004, lon: -80.3998, altitudeM: TOWN_M },
  { name: "Boca Raton", lat: 26.3683, lon: -80.1289, altitudeM: TOWN_M },
  { name: "West Palm Beach", lat: 26.7153, lon: -80.0534, altitudeM: TOWN_M },
  { name: "Fort Myers", lat: 26.6406, lon: -81.8723, altitudeM: TOWN_M },
  { name: "Immokalee", lat: 26.4187, lon: -81.4173, altitudeM: TOWN_M },
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

/** Great-circle distance in km. */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Reverse lookup for plain-language summaries: the nearest town or landmark within `maxKm`, or null. Large
 * areas (the national park, bays, the Keys) are skipped, so a point reads "near Homestead", not "near the
 * Everglades".
 */
export function nearestPlace(lat: number, lon: number, maxKm = 12): Place | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: Place | null = null;
  let bestKm = maxKm;
  for (const place of PLACES) {
    if (place.altitudeM > UNIT_M) continue;
    const km = distanceKm(lat, lon, place.lat, place.lon);
    if (km <= bestKm) {
      best = place;
      bestKm = km;
    }
  }
  return best;
}
