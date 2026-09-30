/**
 * Tiny observable cell for HUD-local data that is not app state: things the HUD derives or fetches for
 * itself (alert bands, per-frame sighting counts). App state stays in the active-state catalog.
 */
import { useSyncExternalStore } from "react";

export type Cell<T> = {
  get(): T;
  set(next: T): void;
  subscribe(cb: () => void): () => void;
};

export function cell<T>(initial: T): Cell<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const cb of listeners) cb();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export function useCell<T>(c: Cell<T>): T {
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}
