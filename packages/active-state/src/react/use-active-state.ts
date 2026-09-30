import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  get,
  getServerSnapshot,
  getSsr,
  resolveKey,
  set as setState,
  subscribe,
  type AnyKey,
} from "@calvinjs/active-state";

type Setter<T> = (value: T | ((prev: T | undefined) => T)) => void;

function applySelector<T, S>(
  value: T | undefined,
  selector?: (value: T) => S,
): T | S | undefined {
  if (selector && value !== undefined) return selector(value);
  return value as T | S | undefined;
}

export function useActiveState<T = unknown>(
  key: AnyKey,
): [T | undefined, Setter<T>];
export function useActiveState<T = unknown, S = T>(
  key: AnyKey,
  selector: (value: T) => S,
): [S | undefined, Setter<T>];
/**
 * Optional `selector` snapshots the selected slice. `useSyncExternalStore`
 * skips re-renders when that snapshot is `Object.is`-equal (even if the key
 * object changed). Prefer selecting a stable field/primitive — avoid
 * returning a fresh object literal each call.
 */
export function useActiveState<T = unknown, S = T>(
  key: AnyKey,
  selector?: (value: T) => S,
): [T | S | undefined, Setter<T>] {
  const id = resolveKey(key);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const subscribeKey = useCallback(
    (onChange: () => void) => subscribe(id, () => onChange()),
    [id],
  );

  const value = useSyncExternalStore(
    subscribeKey,
    () => applySelector(get<T>(id), selectorRef.current),
    getSsr()
      ? () => applySelector(getServerSnapshot<T>(id), selectorRef.current)
      : undefined,
  );

  // Stable identity — effects that list the setter in deps must not re-fire every render.
  const set: Setter<T> = useCallback(
    (next) => {
      setState<T>(id, next);
    },
    [id],
  );

  return [value, set];
}

