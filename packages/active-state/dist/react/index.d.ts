import { init, get, set, subscribe, reset, clearPersisted, hydratePersisted, key, catalog, resolveKey, AnyKey } from '@calvinjs/active-state';
export { STORAGE_PREFIX, catalog, clearPersisted as clearLocalStateKey, clearPersisted, key, registeredState, resolveKey, storageKey } from '@calvinjs/active-state';
import { bind } from '@calvinjs/active-state/dom';

type ActiveStateInit = Record<string, unknown>;
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
declare function ActiveStateRoot({ init, any, ssr, storagePrefix, sharePersisted, persistIds, }: ActiveStateProps): null;
/** Drop once in root layout. Initializes the singleton; renders nothing. */
declare const ActiveState: typeof ActiveStateRoot & {
    init: typeof init;
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

type Setter$1<T> = (value: T | ((prev: T | undefined) => T)) => void;
declare function useActiveState<T = unknown>(key: AnyKey): [T | undefined, Setter$1<T>];
declare function useActiveState<T = unknown, S = T>(key: AnyKey, selector: (value: T) => S): [S | undefined, Setter$1<T>];

/** Compat alias — same as `useActiveState`. */
declare const useClientState: typeof useActiveState;

type UseLocalStateOptions = {
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
/**
 * Compat alias for persisted UI prefs — same as `useActiveState`.
 * Mark the key with `key(id, defaults, { persist: true })` or pass
 * `persistIds` to `init` / `<ActiveState />`.
 */
declare function useLocalState<T = unknown>(key: AnyKey, selectorOrOptions?: ((value: T) => unknown) | UseLocalStateOptions, maybeOptions?: UseLocalStateOptions): [T | undefined, Setter<T>];

export { ActiveState, type ActiveStateInit, type UseLocalStateOptions, useActiveState, useClientState, useLocalState };
