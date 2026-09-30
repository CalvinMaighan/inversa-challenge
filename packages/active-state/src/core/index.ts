import { getStateInstance, resetStateInstance } from "./get-state-instance";
import { init } from "./init";
import { assertUppercaseId } from "./key-format";
import {
  getEnforceKeys,
  getServerSnapshot,
  getSsr,
  resetOptions,
} from "./options";
import { uuid } from "./uuid";

export { createObservable } from "./create-observable";
export type { Observable, Observer } from "./create-observable";
export { createEventBus } from "./create-event-bus";
export type { EventBus } from "./create-event-bus";
export { getStateInstance } from "./get-state-instance";
export { init } from "./init";
export type { InitOptions } from "./init";
export { isUppercaseId, assertUppercaseId } from "./key-format";
export {
  catalog,
  clearRegistry,
  key,
  registeredState,
  resolveKey,
  type AnyKey,
  type KeyPrimitive,
  type KeySlice,
} from "./key";
export { getServerSnapshot, getSsr } from "./options";
export {
  getStoragePrefix,
  isPersisted,
  isShared,
  markPersisted,
  markPersistedIds,
  persistedIds,
  readPersisted,
  STORAGE_PREFIX,
  storageKey,
} from "./persist";
export { uuid } from "./uuid";

import { clearRegistry, resolveKey, type AnyKey } from "./key";
import {
  persistedIds,
  readPersisted,
  removePersisted,
  resetPersistRuntime,
} from "./persist";

function assertKey(key: string): void {
  if (getEnforceKeys()) assertUppercaseId(key);
}

export function get<T = unknown>(key: AnyKey): T | undefined {
  const id = resolveKey(key);
  assertKey(id);
  const source = getStateInstance().getSource(id);
  return source?.getValue() as T | undefined;
}

export function set<T = unknown>(
  key: AnyKey,
  value: T | ((prev: T | undefined) => T),
): void {
  const id = resolveKey(key);
  assertKey(id);
  const bus = getStateInstance();
  // Avoid getSource here so unknown keys warn once inside update().
  const prev = bus.keys().includes(id)
    ? (bus.getSource(id)?.getValue() as T | undefined)
    : undefined;
  const next =
    typeof value === "function"
      ? (value as (p: T | undefined) => T)(prev)
      : value;
  // Persist runs inside the bus.update bridge for persist: true keys.
  bus.update(id, next);
}

export function subscribe(
  key: AnyKey,
  listener: (value: unknown) => void,
): () => void {
  const id = resolveKey(key);
  assertKey(id);
  const source = getStateInstance().getSource(id);
  if (!source) return () => {};

  const subId = uuid();
  source.subscribe({
    id: subId,
    next: listener,
    complete: () => {},
  });
  return () => source.unsubscribe(subId);
}

/**
 * Re-read persisted keys from localStorage into the live store.
 * Normally automatic; useful after login or manual storage edits.
 */
export function hydratePersisted(): void {
  for (const id of persistedIds()) {
    const stored = readPersisted(id);
    if (stored !== undefined) set(id, stored);
  }
}

/**
 * Remove `persist: true` entries from localStorage (`active-state:KEY`).
 * Omit `key` to clear every persisted id. Does not change in-memory bus values.
 */
export function clearPersisted(key?: AnyKey | AnyKey[]): void {
  if (key === undefined) {
    removePersisted();
    return;
  }
  const ids = (Array.isArray(key) ? key : [key]).map(resolveKey);
  removePersisted(ids);
}

export function reset(): void {
  try {
    const bus = getStateInstance();
    for (const key of bus.keys()) {
      bus.getSource(key)?.complete();
    }
  } catch {
    // not initialized
  }
  resetPersistRuntime();
  resetStateInstance();
  resetOptions();
  clearRegistry();
}

