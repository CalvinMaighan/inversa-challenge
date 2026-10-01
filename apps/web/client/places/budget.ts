/**
 * The Google Places request budget (docs/places.md): each browser session (tab) may send at most `cap` Places
 * requests, default 200, editable next to the Google 3D cap in the Developer panel. The cap lives in localStorage
 * (a setting); the count lives in sessionStorage, so a reload keeps it and a new tab starts at zero. Pure over
 * `Storage`-shaped stores that may be missing or throw.
 */

export const PLACES_CAP_STORAGE_KEY = "inversa:places-cap";
export const PLACES_COUNT_STORAGE_KEY = "inversa:places-requests";
export const PLACES_DEFAULT_CAP = 200;
/** Above this a typo would let one tab run up a real bill. */
export const PLACES_MAX_CAP = 10_000;

export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const read = (store: KeyValueStore | null, key: string): string | null => {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const write = (store: KeyValueStore | null, key: string, value: string): void => {
  try {
    store?.setItem(key, value);
  } catch {
    // Blocked or full storage: the value applies for this page load only.
  }
};

const validCap = (n: number) => Number.isInteger(n) && n >= 1 && n <= PLACES_MAX_CAP;

export function readPlacesCap(store: KeyValueStore | null): number {
  const raw = read(store, PLACES_CAP_STORAGE_KEY);
  const n = Number(raw);
  return raw !== null && validCap(n) ? n : PLACES_DEFAULT_CAP;
}

/** Store a new cap; an invalid one is refused. Returns the cap now in force. */
export function writePlacesCap(store: KeyValueStore | null, cap: number): number {
  if (validCap(cap)) write(store, PLACES_CAP_STORAGE_KEY, String(cap));
  return readPlacesCap(store);
}

export function placesUsed(session: KeyValueStore | null): number {
  const n = Number(read(session, PLACES_COUNT_STORAGE_KEY));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** In-memory count for when sessionStorage is unavailable, so the cap still holds for this page load. */
let memoryCount = 0;

/** Reserve `n` requests. False (and nothing counted) when that would pass the cap. */
export function takePlacesRequests(store: KeyValueStore | null, session: KeyValueStore | null, n = 1): boolean {
  const used = Math.max(placesUsed(session), memoryCount);
  if (used + n > readPlacesCap(store)) return false;
  memoryCount = used + n;
  write(session, PLACES_COUNT_STORAGE_KEY, String(used + n));
  return true;
}

/** Test seam: forget the in-memory count. */
export function resetPlacesMemoryCount(): void {
  memoryCount = 0;
}

/**
 * The Developer panel's save: the `places-cap` field of its form, when present and changed. Returns the line to
 * show, or null when there is nothing to save.
 */
export function savePlacesCapField(store: KeyValueStore | null, form: Pick<FormData, "get" | "has">): string | null {
  if (!form.has("places-cap")) return null;
  const value = Number(form.get("places-cap"));
  if (value === readPlacesCap(store)) return null;
  const now = writePlacesCap(store, value);
  return now === value ? `Place search cap set to ${now} requests a session.` : `The search cap must be a whole number from 1 to ${PLACES_MAX_CAP}.`;
}
