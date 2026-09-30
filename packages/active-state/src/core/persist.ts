/** Default localStorage key prefix for persisted store ids. */
export const STORAGE_PREFIX = "active-state:";

let storagePrefix = STORAGE_PREFIX;

const persistIds = new Set<string>();
/** Persisted keys that also mirror other tabs via the `storage` event. */
const sharedIds = new Set<string>();

/** Skip disk writes while applying a remote `storage` event (same-tab echo guard). */
let suppressPersistWrite = false;

export function getStoragePrefix(): string {
  return storagePrefix;
}

export function setStoragePrefix(prefix: string): void {
  storagePrefix = prefix;
}

export function markPersisted(id: string): void {
  persistIds.add(id);
}

export function markShared(id: string): void {
  sharedIds.add(id);
}

/** Mark many ids persisted (e.g. host app list without per-key `key(..., { persist })`). */
export function markPersistedIds(ids: string[]): void {
  for (const id of ids) persistIds.add(id);
}

/** Mark every currently persisted id as shared (cross-tab). */
export function shareAllPersisted(): void {
  for (const id of persistIds) sharedIds.add(id);
}

export function clearPersistedIds(): void {
  persistIds.clear();
  sharedIds.clear();
}

export function resetPersistRuntime(): void {
  clearPersistedIds();
  storagePrefix = STORAGE_PREFIX;
  suppressPersistWrite = false;
  stopStorageSync();
}

export function isPersisted(id: string): boolean {
  return persistIds.has(id);
}

export function isShared(id: string): boolean {
  return sharedIds.has(id);
}

export function persistedIds(): string[] {
  return [...persistIds];
}

export function sharedIdsList(): string[] {
  return [...sharedIds];
}

export function storageKey(id: string): string {
  return getStoragePrefix() + id;
}

function canUseStorage(): boolean {
  return typeof globalThis.localStorage !== "undefined";
}

export function readPersisted(id: string): unknown | undefined {
  if (!canUseStorage()) return undefined;
  const sk = storageKey(id);
  try {
    const raw = globalThis.localStorage.getItem(sk);
    if (raw == null) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      globalThis.localStorage.removeItem(sk);
    } catch {
      /* private mode */
    }
    return undefined;
  }
}

export function writePersisted(id: string, value: unknown): void {
  if (suppressPersistWrite || !canUseStorage()) return;
  try {
    globalThis.localStorage.setItem(storageKey(id), JSON.stringify(value));
  } catch {
    // quota / private mode — ignore
  }
}

/**
 * Remove persisted entries from localStorage.
 * Omit `ids` to clear every key marked `persist: true`.
 */
export function removePersisted(ids?: string | string[]): void {
  if (!canUseStorage()) return;
  const list = ids === undefined ? persistedIds() : Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    try {
      globalThis.localStorage.removeItem(storageKey(id));
    } catch {
      /* ignore */
    }
  }
}

/** Overlay localStorage values onto a state map (browser only). */
export function applyPersistedToState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (!canUseStorage() || persistIds.size === 0) return state;
  const next = { ...state };
  for (const id of persistIds) {
    if (!(id in next)) continue;
    const stored = readPersisted(id);
    if (stored !== undefined) next[id] = stored;
  }
  return next;
}

/**
 * Run `fn` without writing localStorage (used when applying cross-tab storage events).
 */
export function withoutPersistWrite(fn: () => void): void {
  suppressPersistWrite = true;
  try {
    fn();
  } finally {
    suppressPersistWrite = false;
  }
}

let stopSync: (() => void) | null = null;
let applyRemote: ((id: string, value: unknown) => void) | null = null;

/** Apply a cross-tab storage payload into the bus (no localStorage write-back). */
export function applyStoragePayload(
  key: string | null,
  newValue: string | null,
  storageArea?: Storage | null,
): void {
  if (!applyRemote) return;
  if (
    storageArea != null &&
    typeof globalThis.localStorage !== "undefined" &&
    storageArea !== globalThis.localStorage
  ) {
    return;
  }
  const prefix = getStoragePrefix();
  if (!key || !key.startsWith(prefix) || newValue == null) return;
  const id = key.slice(prefix.length);
  if (!isShared(id)) return;
  try {
    const parsed = JSON.parse(newValue) as unknown;
    withoutPersistWrite(() => applyRemote!(id, parsed));
  } catch {
    /* ignore corrupt payloads */
  }
}

/**
 * Mirror other-tab `localStorage` writes for keys marked `{ persist: true, shared: true }`.
 * No-ops when no shared keys, on the server, or when `window` is missing.
 */
export function startStorageSync(
  apply: (id: string, value: unknown) => void,
): void {
  stopStorageSync();
  applyRemote = apply;
  // No listener when nothing is shared — applyStoragePayload still works for tests.
  if (sharedIds.size === 0) return;

  const win = globalThis.window;
  if (typeof win === "undefined" || typeof win.addEventListener !== "function") {
    return;
  }

  const onStorage = (event: Event) => {
    const e = event as StorageEvent;
    applyStoragePayload(e.key, e.newValue, e.storageArea);
  };

  win.addEventListener("storage", onStorage);
  stopSync = () => win.removeEventListener("storage", onStorage);
}

export function stopStorageSync(): void {
  stopSync?.();
  stopSync = null;
  applyRemote = null;
}
