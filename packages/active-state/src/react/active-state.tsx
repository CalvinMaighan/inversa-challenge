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
  subscribe,
  type InitOptions,
} from "@calvinjs/active-state";
import { bind } from "@calvinjs/active-state/dom";
import { useLayoutEffect } from "react";

export type ActiveStateInit = Record<string, unknown>;

type ActiveStateProps = {
  /**
   * Initial store map — required. Pass your catalog snapshot, e.g.
   * `import { state } from "client/state"` then `<ActiveState init={state} />`.
   */
  init: ActiveStateInit;
  /** Allow any key format. Default false (UPPERCASE_IDS required). */
  any?: boolean;
  /**
   * SSR / static-export safe hydration for useActiveState.
   * Uses init values as the server snapshot; hydrates localStorage in
   * useLayoutEffect before paint.
   */
  ssr?: boolean;
  /** localStorage prefix (default `active-state:`). */
  storagePrefix?: string;
  /** Mark all persisted keys cross-tab. */
  sharePersisted?: boolean;
  /** Extra ids to persist at boot. */
  persistIds?: string[];
};

function ActiveStateRoot({
  init,
  any = false,
  ssr = false,
  storagePrefix,
  sharePersisted,
  persistIds,
}: ActiveStateProps): null {
  if (init == null || Object.keys(init).length === 0) {
    throw new Error(
      "[active-state] <ActiveState init={…} /> requires a non-empty map. " +
        'Import your catalog (e.g. import { state } from "client/state") and pass init={state}.',
    );
  }
  // initState is idempotent — safe under Strict Mode / re-renders
  const options: InitOptions = {
    any,
    ssr,
    storagePrefix,
    sharePersisted,
    persistIds,
  };
  initState(init, options);

  useLayoutEffect(() => {
    if (!ssr) return;
    if (typeof globalThis.window === "undefined") return;
    hydratePersisted();
  }, [ssr]);

  return null;
}

/** Drop once in root layout. Initializes the singleton; renders nothing. */
export const ActiveState = Object.assign(ActiveStateRoot, {
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
  resolveKey,
}) as typeof ActiveStateRoot & {
  init: typeof initState;
  get: typeof get;
  set: typeof set;
  subscribe: typeof subscribe;
  reset: typeof reset;
  clearPersisted: typeof clearPersisted;
  hydratePersisted: typeof hydratePersisted;
  bind: typeof bind;
  key: typeof key;
  catalog: typeof catalog;
  resolveKey: typeof resolveKey;
  readonly state: Record<string, unknown>;
};

Object.defineProperty(ActiveState, "state", {
  get: () => registeredState(),
  enumerable: true,
});
