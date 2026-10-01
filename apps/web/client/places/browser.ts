/**
 * The real dependencies of `client/places/search.ts`: the browser's Google key (client/keys.ts, GE3), the Google 3D
 * cap (client/globe/quota.ts), the active app's box, the page language, localStorage for the cap and
 * sessionStorage for the count, and the service origins.
 *
 * Origin override, development and e2e builds only (`NODE_ENV !== "production"` or `NEXT_PUBLIC_INVERSA_E2E=1`,
 * the same guard as `window.__inversa`): `NEXT_PUBLIC_PLACES_BASE_URL` at build time, else localStorage
 * `inversa:places-base`. Both Google and Photon then go to that origin (e2e/places.ts serves a local stub there).
 * A production build ignores both and always calls places.googleapis.com and photon.komoot.io.
 */
import { appBBox } from "shared/apps";
import { PHOTON_ORIGIN, PLACES_ORIGIN } from "shared/places";

import { googleCapReached, readGoogleQuota } from "client/globe/quota";
import { browserKey, browserKeyStore } from "client/keys";
import { activeApp } from "client/state/app";
import { PLACES as GAZETTEER } from "client/voice/gazetteer";

import type { SearchDeps } from "./search";

export const PLACES_BASE_STORAGE_KEY = "inversa:places-base";

const DEV_OR_TEST = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_INVERSA_E2E === "1";

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The override origin when allowed and well formed (http(s), no path), else null. */
export function overrideOrigin(raw: string | null | undefined, allowed = DEV_OR_TEST): string | null {
  if (!allowed || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function placesOrigins(store: Pick<Storage, "getItem"> | null = browserKeyStore()): { google: string; photon: string } {
  let stored: string | null = null;
  try {
    stored = store?.getItem(PLACES_BASE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  const o = overrideOrigin(process.env.NEXT_PUBLIC_PLACES_BASE_URL) ?? overrideOrigin(stored);
  return o ? { google: o, photon: o } : { google: PLACES_ORIGIN, photon: PHOTON_ORIGIN };
}

export function browserPlacesDeps(): SearchDeps {
  const store = browserKeyStore();
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    key: () => browserKey("google-maps", store),
    googleMap: () => !googleCapReached(readGoogleQuota(store, Date.now())),
    bbox: () => appBBox(activeApp()),
    language: () => (typeof navigator === "undefined" ? "en" : navigator.language || "en"),
    origins: () => placesOrigins(store),
    localPlaces: () => GAZETTEER,
    store,
    session: sessionStore(),
  };
}
