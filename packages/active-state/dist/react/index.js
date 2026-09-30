"use client";

// src/react/index.ts
import {
  catalog as catalog2,
  clearPersisted as clearPersisted2,
  key as key2,
  registeredState as registeredState2,
  resolveKey as resolveKey3,
  STORAGE_PREFIX,
  storageKey
} from "active-state";

// src/react/active-state.tsx
import {
  catalog,
  clearPersisted,
  get,
  hydratePersisted,
  init as initState,
  key,
  registeredState,
  reset,
  resolveKey,
  set,
  subscribe
} from "active-state";
import { bind } from "active-state/dom";
import { useLayoutEffect } from "react";
function ActiveStateRoot({
  init,
  any = false,
  ssr = false,
  storagePrefix,
  sharePersisted,
  persistIds
}) {
  if (init == null || Object.keys(init).length === 0) {
    throw new Error(
      '[active-state] <ActiveState init={\u2026} /> requires a non-empty map. Import your catalog (e.g. import { state } from "client/state") and pass init={state}.'
    );
  }
  const options = {
    any,
    ssr,
    storagePrefix,
    sharePersisted,
    persistIds
  };
  initState(init, options);
  useLayoutEffect(() => {
    if (!ssr) return;
    if (typeof globalThis.window === "undefined") return;
    hydratePersisted();
  }, [ssr]);
  return null;
}
var ActiveState = Object.assign(ActiveStateRoot, {
  init: initState,
  get,
  set,
  subscribe,
  reset,
  clearPersisted,
  hydratePersisted,
  bind,
  key,
  catalog,
  resolveKey
});
Object.defineProperty(ActiveState, "state", {
  get: () => registeredState(),
  enumerable: true
});

// src/react/use-active-state.ts
import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  get as get2,
  getServerSnapshot,
  getSsr,
  resolveKey as resolveKey2,
  set as setState,
  subscribe as subscribe2
} from "active-state";
function applySelector(value, selector) {
  if (selector && value !== void 0) return selector(value);
  return value;
}
function useActiveState(key3, selector) {
  const id = resolveKey2(key3);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const subscribeKey = useCallback(
    (onChange) => subscribe2(id, () => onChange()),
    [id]
  );
  const value = useSyncExternalStore(
    subscribeKey,
    () => applySelector(get2(id), selectorRef.current),
    getSsr() ? () => applySelector(getServerSnapshot(id), selectorRef.current) : void 0
  );
  const set2 = useCallback(
    (next) => {
      setState(id, next);
    },
    [id]
  );
  return [value, set2];
}

// src/react/use-client-state.ts
var useClientState = useActiveState;

// src/react/use-local-state.ts
import { getSsr as getSsr2 } from "active-state";
function resolveArgs(selectorOrOptions, maybeOptions) {
  if (typeof selectorOrOptions === "function") {
    return { selector: selectorOrOptions, options: maybeOptions };
  }
  if (selectorOrOptions != null && typeof selectorOrOptions === "object" && ("hydrationSafe" in selectorOrOptions || "json" in selectorOrOptions)) {
    return { options: selectorOrOptions };
  }
  return { options: maybeOptions };
}
function useLocalState(key3, selectorOrOptions, maybeOptions) {
  const { selector, options } = resolveArgs(selectorOrOptions, maybeOptions);
  if (options?.json === false) {
    throw new Error(
      "[active-state] useLocalState({ json: false }) is unsupported. Persisted values are always JSON. Keep non-JSON data on non-persist keys."
    );
  }
  if (options?.hydrationSafe === true && !getSsr2() && typeof console !== "undefined") {
    console.warn(
      "[active-state] useLocalState({ hydrationSafe: true }) requires init(..., { ssr: true }) or <ActiveState ssr />."
    );
  }
  if (selector) {
    return useActiveState(key3, selector);
  }
  return useActiveState(key3);
}

// src/react/index.ts
import { clearPersisted as clearPersisted3 } from "active-state";
export {
  ActiveState,
  STORAGE_PREFIX,
  catalog2 as catalog,
  clearPersisted3 as clearLocalStateKey,
  clearPersisted2 as clearPersisted,
  key2 as key,
  registeredState2 as registeredState,
  resolveKey3 as resolveKey,
  storageKey,
  useActiveState,
  useClientState,
  useLocalState
};
