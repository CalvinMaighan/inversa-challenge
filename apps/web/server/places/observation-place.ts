/**
 * The place name a sighting's source gives it, for the line under the photo on the sighting card ("Costa Occ. de Isla
 * Mujeres, Pta Cancún y Pta Nizuc, Isla Mujeres, MX-QR, MX", as iNaturalist writes it). We store only the coordinates,
 * so the name is asked of the source's public API when a card opens, once per record: the answer is kept in memory (a
 * record's place does not change, so a month) and misses are kept a day, so a busy card never turns into repeated calls.
 */
import type { ObservationSource } from "@/shared/observation-source";

const HIT_TTL_MS = 30 * 86_400_000;
const MISS_TTL_MS = 86_400_000;
const MAX_ENTRIES = 5_000;
const TIMEOUT_MS = 8_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Entry = { at: number; place: string | null };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : null);

/** iNaturalist writes the place the observer chose or the site guessed: `place_guess`. */
export function inatPlace(body: unknown): string | null {
  const first = (body as { results?: { place_guess?: unknown }[] } | null)?.results?.[0];
  return text(first?.place_guess);
}

/** GBIF has no single line: the locality, then the region and country when they add something. */
export function gbifPlace(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const parts = [text(b.locality) ?? text(b.verbatimLocality), text(b.stateProvince), text(b.country)].filter((p): p is string => !!p);
  const seen = new Set<string>();
  const unique = parts.filter((p) => (seen.has(p.toLowerCase()) ? false : (seen.add(p.toLowerCase()), true)));
  return unique.length ? unique.join(", ") : null;
}

async function ask(src: ObservationSource, fetchImpl: Fetch): Promise<string | null> {
  const url = src.source === "inat" ? `https://api.inaturalist.org/v1/observations/${src.id}` : `https://api.gbif.org/v1/occurrence/${src.id}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "inversa-sighting-card (+https://inversa.bigvalue.lol)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${src.source} HTTP ${res.status}`);
  const body: unknown = await res.json();
  return src.source === "inat" ? inatPlace(body) : gbifPlace(body);
}

/** The place name for one record, or null when the source has none or cannot be reached. */
export async function observationPlace(src: ObservationSource, fetchImpl: Fetch = fetch, now = Date.now()): Promise<string | null> {
  const key = `${src.source}:${src.id}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < (hit.place ? HIT_TTL_MS : MISS_TTL_MS)) return hit.place;
  let pending = inflight.get(key);
  if (!pending) {
    pending = ask(src, fetchImpl)
      .catch(() => null)
      .then((place) => {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: now, place });
        return place;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** Test hook. */
export function resetObservationPlaces(): void {
  cache.clear();
  inflight.clear();
}
