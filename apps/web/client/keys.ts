/**
 * Browser keys at runtime (docs/GODS_EYE.md GC3): localStorage `inversa:keys:<id>` (the Developer panel) first,
 * then the build-time `NEXT_PUBLIC_*` value. The rules live in `shared/keys.ts`; this file holds the browser
 * globals shared/ may not touch.
 */
import { resolveBrowserKey, type BrowserKeyId, type BuildKeys, type KeyStore } from "shared/keys";

/** Written out literally so Next inlines them into the client bundle; any other `process.env` read is undefined there. */
export function buildTimeBrowserKeys(): BuildKeys {
  return {
    "google-maps": process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
    "cesium-ion": process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN,
  };
}

/** `localStorage`, or null where it is missing or access throws. */
export function browserKeyStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The browser key's value for the globe, or undefined. */
export function browserKey(id: BrowserKeyId, store: KeyStore | null = browserKeyStore()): string | undefined {
  return resolveBrowserKey(id, store, buildTimeBrowserKeys()).value ?? undefined;
}
