/**
 * Asian carp sightings for the carp app's map: silver, bighead, grass and black carp in the app's Louisiana region, merged from
 * iNaturalist, GBIF (without its copy of iNaturalist's own records) and the USGS Nonindigenous Aquatic Species database, newest
 * first. Fetched live from the public APIs on the server (no browser CORS or COEP trouble) and kept for ten minutes.
 */
import { NextResponse } from "next/server";

import type { CarpSighting } from "client/carp/sighting-type";

export const dynamic = "force-dynamic";

const BBOX = { west: -94, south: 28.9, east: -88.8, north: 32.9 };
const SPECIES = [
  { id: "silver", name: "Silver carp", sci: "Hypophthalmichthys molitrix", inat: 128274, gbif: 2362473, nasGenus: "Hypophthalmichthys", nasSpecies: "molitrix" },
  { id: "bighead", name: "Bighead carp", sci: "Hypophthalmichthys nobilis", inat: 130886, gbif: 2362486, nasGenus: "Hypophthalmichthys", nasSpecies: "nobilis" },
  { id: "grass", name: "Grass carp", sci: "Ctenopharyngodon idella", inat: 128500, gbif: 2362030, nasGenus: "Ctenopharyngodon", nasSpecies: "idella" },
  { id: "black", name: "Black carp", sci: "Mylopharyngodon piceus", inat: 128426, gbif: 2362110, nasGenus: "Mylopharyngodon", nasSpecies: "piceus" },
] as const;
const INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";
const TTL_MS = 10 * 60_000;
const HEADERS = { "user-agent": "inversa-carp/1.0 (https://inversa.calvinmaighan.dev)", accept: "application/json" };


let cache: { at: number; body: { fetchedAt: string; sightings: CarpSighting[]; sources: Record<string, number | string> } } | null = null;

const bySci = (sci: string) => SPECIES.find((s) => sci.toLowerCase().startsWith(s.sci.toLowerCase()));

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

async function inat(): Promise<CarpSighting[]> {
  const url = `https://api.inaturalist.org/v1/observations?taxon_id=${SPECIES.map((s) => s.inat).join(",")}&swlat=${BBOX.south}&swlng=${BBOX.west}&nelat=${BBOX.north}&nelng=${BBOX.east}&per_page=200&order_by=observed_on&order=desc&geoprivacy=open&quality_grade=research,needs_id`;
  const body = (await json(url)) as { results: { id: number; observed_on?: string; location?: string; uri: string; taxon?: { name: string }; photos?: { url?: string }[] }[] };
  return body.results.flatMap((o): CarpSighting[] => {
    const sp = o.taxon ? bySci(o.taxon.name) : undefined;
    const [lat, lon] = (o.location ?? "").split(",").map(Number);
    if (!sp || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{ id: `inat:${o.id}`, source: "inat", species: sp.name, scientificName: sp.sci, lat: lat!, lon: lon!, date: o.observed_on ?? null, url: o.uri, photo: o.photos?.[0]?.url?.replace("square", "medium") ?? null }];
  });
}

async function gbif(): Promise<CarpSighting[]> {
  const keys = SPECIES.map((s) => `taxonKey=${s.gbif}`).join("&");
  const url = `https://api.gbif.org/v1/occurrence/search?${keys}&hasCoordinate=true&decimalLatitude=${BBOX.south},${BBOX.north}&decimalLongitude=${BBOX.west},${BBOX.east}&limit=300`;
  const body = (await json(url)) as { results: { key: number; datasetKey: string; species?: string; eventDate?: string; decimalLatitude?: number; decimalLongitude?: number }[] };
  return body.results.flatMap((o): CarpSighting[] => {
    const sp = o.species ? bySci(o.species) : undefined;
    // GBIF mirrors iNaturalist's research-grade records; those come from iNaturalist directly.
    if (!sp || o.datasetKey === INAT_DATASET || typeof o.decimalLatitude !== "number" || typeof o.decimalLongitude !== "number") return [];
    return [{ id: `gbif:${o.key}`, source: "gbif", species: sp.name, scientificName: sp.sci, lat: o.decimalLatitude, lon: o.decimalLongitude, date: o.eventDate?.slice(0, 10) ?? null, url: `https://www.gbif.org/occurrence/${o.key}`, photo: null }];
  });
}

async function nas(): Promise<CarpSighting[]> {
  const out: CarpSighting[] = [];
  for (const genus of new Set(SPECIES.map((s) => s.nasGenus))) {
    const body = (await json(`https://nas.er.usgs.gov/api/v2/occurrence/search?state=LA&genus=${genus}&limit=200`)) as { results?: { key: number; genus: string; species: string; decimalLatitude: number; decimalLongitude: number; year?: number | null; month?: number | null; day?: number | null; speciesID: number }[] };
    for (const o of body.results ?? []) {
      const sp = bySci(`${o.genus} ${o.species}`);
      if (!sp || !Number.isFinite(o.decimalLatitude) || !Number.isFinite(o.decimalLongitude)) continue;
      const date = o.year ? [o.year, o.month, o.day].filter((v) => v != null).map((v, i) => (i === 0 ? String(v) : String(v).padStart(2, "0"))).join("-") : null;
      out.push({ id: `nas:${o.key}`, source: "nas", species: sp.name, scientificName: sp.sci, lat: o.decimalLatitude, lon: o.decimalLongitude, date, url: `https://nas.er.usgs.gov/queries/SpecimenViewer.aspx?SpecimenID=${o.key}`, photo: null });
    }
  }
  return out;
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);
  const sources: Record<string, number | string> = {};
  const settled = await Promise.allSettled([inat(), gbif(), nas()]);
  const all: CarpSighting[] = [];
  (["inat", "gbif", "nas"] as const).forEach((name, i) => {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      sources[name] = r.value.length;
      all.push(...r.value);
    } else sources[name] = `unavailable: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`;
  });
  all.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const body = { fetchedAt: new Date().toISOString(), sightings: all, sources };
  // Only a result with data is kept, so a failed refresh is retried on the next request.
  if (all.length > 0) cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
