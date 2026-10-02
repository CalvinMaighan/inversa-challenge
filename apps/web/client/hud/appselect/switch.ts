/**
 * Switching apps from the browser (PLAN.md C-A5): the store resets (`applyApp`), the URL gets `?app=<id>` with
 * the old app's share-link hash dropped (its camera, layers and species belong to the old app; `ShareLinkSync`
 * writes the new app's view a moment later), and the choice is remembered in localStorage. A storage failure is
 * swallowed: the URL still carries the app.
 */
import { applyApp } from "client/state/app-switch";
import { APP_PARAM, resolveActiveApp, storeApp } from "client/state/app";
import { isVoiceLive, stopVoice } from "client/voice/voice-runtime";
import type { AppId } from "shared/apps";

export type SwitchEnv = {
  location: Pick<Location, "href">;
  history: Pick<History, "replaceState" | "state">;
  storage: Pick<Storage, "setItem"> | null;
};

function browserEnv(): SwitchEnv | null {
  if (typeof window === "undefined") return null;
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return { location: window.location, history: window.history, storage };
}

/** `href` with `?app=<id>` and no hash. */
export function switchedUrl(href: string, id: AppId): string {
  const url = new URL(href);
  url.searchParams.set(APP_PARAM, id);
  url.hash = "";
  return url.toString();
}

/**
 * Make `id` the active app: store, URL and remembered choice. A live voice session belongs to the old app (its
 * persona and tools), so it is stopped. Returns whether anything changed in the store.
 */
export function switchApp(id: AppId, env: SwitchEnv | null = browserEnv()): boolean {
  if (env && isVoiceLive()) stopVoice({ notifyServer: true });
  const changed = applyApp(id);
  if (env) {
    const next = switchedUrl(env.location.href, id);
    if (next !== env.location.href) env.history.replaceState(env.history.state, "", next);
    storeApp(env.storage, id);
  }
  return changed;
}

/**
 * The app to start in (AppBoot, after hydration): `?app=`, a share link's app, localStorage, carp. The URL is
 * then normalised to carry `?app=` (keeping the hash, which belongs to this app) so a copied link reopens here.
 */
export function bootApp(env: SwitchEnv & { location: Pick<Location, "href" | "search" | "hash"> }, storage: Pick<Storage, "getItem"> | null): AppId {
  const id = resolveActiveApp({ search: env.location.search, hash: env.location.hash, storage });
  applyApp(id);
  const url = new URL(env.location.href);
  if (url.searchParams.get(APP_PARAM) !== id) {
    url.searchParams.set(APP_PARAM, id);
    env.history.replaceState(env.history.state, "", url.toString());
  }
  storeApp(env.storage, id);
  return id;
}
