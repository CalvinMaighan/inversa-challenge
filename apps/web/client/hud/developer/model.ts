/**
 * The Developer panel's rows (docs/GODS_EYE.md "Developer panel spec"), from `KEY_REGISTRY`, this browser's
 * stored keys and the server's `GET /api/dev/keys`. Pure, so the rules are unit-tested: no value is ever part of
 * a row, only whether it is set and where from.
 */
import { buildTimeBrowserKeys } from "client/keys";
import {
  browserKeyStorageKey,
  KEY_REGISTRY,
  resolveBrowserKey,
  type BrowserKeyId,
  type BuildKeys,
  type KeyEntry,
  type KeyStore,
  type ServerKeyStatus,
} from "shared/keys";

export const DEV_KEYS_URL = "/api/dev/keys";

export type PanelRow = {
  id: string;
  label: string;
  scope: KeyEntry["scope"];
  priority: KeyEntry["priority"];
  purpose: string;
  set: boolean;
  /** Set through the build env, the shell or Doppler: shown, never touched. */
  external: boolean;
  /** Saved to data/local-keys.env; the API and web are restarting to load it. */
  pending: boolean;
  /** A browser key this browser stores (it can be removed here). */
  removable: boolean;
  link: { label: "MANAGE" | "GET KEY"; href: string };
  /** Paste fields: one per unset variable, only where this panel can save it. */
  inputs: { name: string; label: string }[];
  /** Server keys this server cannot take (production, or not loopback): the command to run instead. */
  commands: string[];
};

/** `null` server status: GET failed or is still loading; server rows then show neither fields nor commands. */
export function panelRows(store: KeyStore | null, server: ServerKeyStatus[] | null, build: BuildKeys = buildTimeBrowserKeys()): PanelRow[] {
  return KEY_REGISTRY.map((k): PanelRow => {
    const base = { id: k.id, label: k.label, scope: k.scope, priority: k.priority, purpose: k.purpose };
    if (k.scope === "browser") {
      const { source } = resolveBrowserKey(k.id, store, build);
      const set = source !== null;
      return {
        ...base,
        set,
        external: source === "build",
        pending: false,
        removable: source === "local",
        link: set ? { label: "MANAGE", href: k.manageUrl } : { label: "GET KEY", href: k.getUrl },
        inputs: set ? [] : k.vars.map((name) => ({ name, label: `${k.label} ${name}` })),
        commands: [],
      };
    }
    const status = server?.find((s) => s.id === k.id) ?? null;
    const set = status?.set ?? false;
    const unset = status ? status.vars.filter((v) => !v.set && v.source !== "pending").map((v) => v.name) : [];
    return {
      ...base,
      set,
      external: status?.source === "external",
      pending: status?.source === "pending",
      removable: false,
      link: set ? { label: "MANAGE", href: k.manageUrl } : { label: "GET KEY", href: k.getUrl },
      inputs: status?.writable ? unset.map((name) => ({ name, label: `${k.label} ${name}` })) : [],
      commands: status && !status.writable ? unset.map((name) => `doppler secrets set ${name}`) : [],
    };
  });
}

/** Split pasted values (trimmed, blanks dropped) into browser keys (by registry id) and server variables. */
export function splitPasted(values: Record<string, string>): { browser: [BrowserKeyId, string][]; server: Record<string, string> } {
  const browser: [BrowserKeyId, string][] = [];
  const server: Record<string, string> = {};
  for (const k of KEY_REGISTRY) {
    for (const name of k.vars) {
      const v = values[name]?.trim();
      if (!v) continue;
      if (k.scope === "browser") browser.push([k.id as BrowserKeyId, v]);
      else server[name] = v;
    }
  }
  return { browser, server };
}

/** Save browser keys to localStorage (never sent anywhere); false when storage refused. */
export function saveBrowserKeys(store: Pick<Storage, "setItem"> | null, keys: [BrowserKeyId, string][]): boolean {
  try {
    for (const [id, value] of keys) store?.setItem(browserKeyStorageKey(id), value);
    return store !== null;
  } catch {
    return false;
  }
}

export function removeBrowserKey(store: Pick<Storage, "removeItem"> | null, id: BrowserKeyId): void {
  try {
    store?.removeItem(browserKeyStorageKey(id));
  } catch {
    // Blocked storage: nothing was stored either.
  }
}
