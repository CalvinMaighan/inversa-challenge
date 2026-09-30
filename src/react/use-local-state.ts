import type { AnyKey } from "active-state";
import { getSsr } from "active-state";
import { useActiveState } from "./use-active-state";

export type UseLocalStateOptions = {
  /**
   * When true, expects `<ActiveState ssr />` / `init(..., { ssr: true })` so
   * the first paint matches the server and `hydratePersisted` runs in
   * useLayoutEffect before paint. Compat option for host apps.
   */
  hydrationSafe?: boolean;
  /**
   * Persisted values are always JSON.
   * `json: false` is unsupported — throws.
   */
  json?: boolean;
};

type Setter<T> = (value: T | ((prev: T | undefined) => T)) => void;

function resolveArgs<T>(
  selectorOrOptions?: ((value: T) => unknown) | UseLocalStateOptions,
  maybeOptions?: UseLocalStateOptions,
): {
  selector?: (value: T) => unknown;
  options?: UseLocalStateOptions;
} {
  if (typeof selectorOrOptions === "function") {
    return { selector: selectorOrOptions, options: maybeOptions };
  }
  if (
    selectorOrOptions != null &&
    typeof selectorOrOptions === "object" &&
    ("hydrationSafe" in selectorOrOptions || "json" in selectorOrOptions)
  ) {
    return { options: selectorOrOptions };
  }
  return { options: maybeOptions };
}

/**
 * Compat alias for persisted UI prefs — same as `useActiveState`.
 * Mark the key with `key(id, defaults, { persist: true })` or pass
 * `persistIds` to `init` / `<ActiveState />`.
 */
export function useLocalState<T = unknown>(
  key: AnyKey,
  selectorOrOptions?: ((value: T) => unknown) | UseLocalStateOptions,
  maybeOptions?: UseLocalStateOptions,
): [T | undefined, Setter<T>] {
  const { selector, options } = resolveArgs(selectorOrOptions, maybeOptions);

  if (options?.json === false) {
    throw new Error(
      "[active-state] useLocalState({ json: false }) is unsupported. " +
        "Persisted values are always JSON. Keep non-JSON data on non-persist keys.",
    );
  }

  if (
    options?.hydrationSafe === true &&
    !getSsr() &&
    typeof console !== "undefined"
  ) {
    console.warn(
      "[active-state] useLocalState({ hydrationSafe: true }) requires " +
        "init(..., { ssr: true }) or <ActiveState ssr />.",
    );
  }

  if (selector) {
    return useActiveState(key, selector as (value: T) => T) as [
      T | undefined,
      Setter<T>,
    ];
  }
  return useActiveState<T>(key);
}
