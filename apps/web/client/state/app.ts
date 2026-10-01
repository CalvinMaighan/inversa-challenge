import { get, key } from "@calvinjs/active-state";

import { APP_IDS, boardIdFor, DEFAULT_APP_ID, getApp, isAppId, type AppConfig, type AppId } from "shared/apps";

/**
 * The active app (PLAN.md C-A5): `?app=` in the URL wins, then localStorage `inversa.app`, then carp. The key
 * holds only the id; everything else is looked up in the config, so a switch is one write here plus the resets
 * in `app-switch.ts`.
 */
export type AppState = { id: AppId };

export const APP = key("APP", { id: DEFAULT_APP_ID } as AppState);

/** localStorage key that remembers the viewer's last app. Not under active-state's prefix: the head script reads it raw. */
export const APP_STORAGE_KEY = "inversa.app";
/** URL search parameter. */
export const APP_PARAM = "app";

type StorageLike = Pick<Storage, "getItem">;

/** The stored app, or null when unset, invalid or storage throws (private mode, blocked site data). */
export function readStoredApp(storage: StorageLike | null | undefined): AppId | null {
  try {
    const v = storage?.getItem(APP_STORAGE_KEY);
    return isAppId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember the app; a storage failure is swallowed (the URL still carries it). */
export function storeApp(storage: Pick<Storage, "setItem"> | null | undefined, id: AppId): void {
  try {
    storage?.setItem(APP_STORAGE_KEY, id);
  } catch {
    // Quota, private mode or blocked storage: the selection still lives in the URL.
  }
}

/** `?app=` of a search string, when it names an app. */
export function appFromSearch(search: string | null | undefined): AppId | null {
  if (!search) return null;
  const v = new URLSearchParams(search).get(APP_PARAM);
  return isAppId(v) ? v : null;
}

/** The app a `v=1` share link (made before there were apps) belongs to: the Everglades build, now python. */
export const V1_APP: AppId = APP_IDS[2];
/** Share-link view fields (`client/hud/share-link.ts`); a hash without any of them is not a link. */
const SHARE_FIELDS = ["c", "t", "l", "sp", "st", "w", "e"];

/**
 * The app a share-link hash belongs to: `v=2` names it (`app=`); a `v=1` link (or one with no version) that
 * carries view fields is python's. Null for any other hash.
 */
export function appFromHash(hash: string | null | undefined): AppId | null {
  if (!hash) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const version = params.get("v") ?? "1";
  if (version === "2") {
    const app = params.get(APP_PARAM);
    return isAppId(app) ? app : null;
  }
  return version === "1" && SHARE_FIELDS.some((k) => params.has(k)) ? V1_APP : null;
}

/**
 * `?app=` beats a share link's app beats localStorage beats the default; anything invalid falls through. The
 * hash is the view within the app, so it only decides when the URL names none (an old `v=1` link opens python).
 */
export function resolveActiveApp(input: { search?: string | null; hash?: string | null; storage?: StorageLike | null }): AppId {
  return appFromSearch(input.search) ?? appFromHash(input.hash) ?? readStoredApp(input.storage) ?? DEFAULT_APP_ID;
}

export function activeAppId(): AppId {
  const id = get<AppState>(APP)?.id;
  return isAppId(id) ? id : DEFAULT_APP_ID;
}

export function activeApp(): AppConfig {
  return getApp(activeAppId());
}

export { boardIdFor };

/**
 * Inline `<head>` script: resolves the app the same way as `resolveActiveApp` before first paint. When it is not
 * the default the server rendered, `data-app-pending` hides the page until `AppBoot` applies the app after
 * hydration (no flash of the wrong app); a 4 s timer unhides it if the bundle never runs.
 */
export function appBootstrapScript(): string {
  const config = JSON.stringify({ ids: APP_IDS, d: DEFAULT_APP_ID, k: APP_STORAGE_KEY, p: APP_PARAM, v1: V1_APP, f: SHARE_FIELDS });
  return (
    `(function(c){var d=document.documentElement,a=null;` +
    `try{a=new URLSearchParams(location.search).get(c.p)}catch(e){}` +
    `if(c.ids.indexOf(a)<0){a=null;try{var h=new URLSearchParams(location.hash.slice(1)),v=h.get("v")||"1";` +
    `if(v==="2")a=h.get(c.p);else if(v==="1"&&c.f.some(function(k){return h.has(k)}))a=c.v1}catch(e){}}` +
    `if(c.ids.indexOf(a)<0){a=null;try{a=localStorage.getItem(c.k)}catch(e){}}` +
    `if(c.ids.indexOf(a)<0)a=c.d;` +
    `d.setAttribute("data-app",a);` +
    `if(a!==c.d){d.setAttribute("data-app-pending","");setTimeout(function(){d.removeAttribute("data-app-pending")},4000)}` +
    `})(${config});`
  );
}
