type Observer<T = unknown> = {
    id: string;
    next: (value: T) => void;
    complete: () => void;
};
type Observable<T = unknown> = {
    subscribe(observer: Observer<T>): void;
    unsubscribe(id: string): void;
    next(nextValue: T): void;
    complete(): void;
    getValue(): T;
};
declare function createObservable<T>(initial: T): Observable<T>;

type EventBus = {
    getSource(id: string): Observable | undefined;
    update(id: string, value: unknown): void;
    keys(): string[];
    /** Live observables map for host introspection. */
    readonly observables: Map<string, Observable>;
};
type CreateEventBusOptions = {
    init?: (observables: Map<string, Observable>) => void;
};
declare function createEventBus(options?: CreateEventBusOptions): EventBus;

declare function getStateInstance(bus?: EventBus): EventBus;

type InitOptions = {
    /** Allow any key format. Default false (UPPERCASE_IDS required). */
    any?: boolean;
    /**
     * SSR / static-export safe snapshots for React hydration.
     * Enables useSyncExternalStore in useActiveState.
     * Call `hydratePersisted()` (or mount `<ActiveState ssr />`) before paint
     * to apply localStorage without a flash.
     */
    ssr?: boolean;
    /** localStorage key prefix. Default `active-state:`. */
    storagePrefix?: string;
    /**
     * Mark every persisted key as cross-tab (`storage` event).
     * Useful when the host previously synced all persisted prefs across tabs.
     */
    sharePersisted?: boolean;
    /**
     * Extra ids to mark persisted at boot (host lists without `key(..., { persist })`).
     */
    persistIds?: string[];
};
declare function init(initialState: Record<string, unknown>, options?: InitOptions): void;

declare function isUppercaseId(key: string): boolean;
declare function assertUppercaseId(key: string): void;

type KeySlice<K extends string, T extends Record<string, unknown>> = {
    readonly $: K;
    readonly defaults: T;
} & {
    readonly [P in keyof T & string]: `${K}.${P}`;
};
type KeyPrimitive<K extends string, T> = {
    readonly $: K;
    readonly defaults: T;
};
type AnyKey = string | {
    readonly $: string;
};
/** Resolve a key string or a `key()` slice to the store id. */
declare function resolveKey(input: AnyKey): string;
/** Snapshot of every `key()` registration (for init / ActiveState.state). */
declare function registeredState(): Record<string, unknown>;
declare function clearRegistry(): void;
type KeyOptions = {
    /** Skip UPPERCASE_IDS check when defining this key. */
    any?: boolean;
    /**
     * Persist this key to `localStorage` under `{prefix}KEY` (browser only).
     * Writes on every bus update (`set` / `getStateInstance().update`).
     * With `<ActiveState ssr />`, `hydratePersisted` runs in useLayoutEffect
     * before paint so server HTML stays matched.
     */
    persist?: boolean;
    /**
     * Cross-tab sync via the `storage` event. Implies `persist: true`.
     *
     * @example
     * key("THEME", { dark: false }, { persist: true, shared: true });
     */
    shared?: boolean;
};
/**
 * Typed store key + path helpers. Also registers defaults into ActiveState.state.
 *
 * @example
 * const THEME = key("THEME", { dark: false }, { persist: true, shared: true });
 */
declare function key<K extends string, T extends Record<string, unknown>>(id: K, defaults: T, options?: KeyOptions): KeySlice<K, T>;
declare function key<K extends string, T>(id: K, defaults: T, options?: KeyOptions): KeyPrimitive<K, T>;
/**
 * Build an init object from slices.
 * With no arguments, returns the auto-registered map (same as ActiveState.state).
 */
declare function catalog(...slices: Array<{
    readonly $: string;
    readonly defaults: unknown;
}>): Record<string, unknown>;

declare function getSsr(): boolean;
declare function getServerSnapshot<T = unknown>(key: string): T | undefined;

/** Default localStorage key prefix for persisted store ids. */
declare const STORAGE_PREFIX = "active-state:";
declare function getStoragePrefix(): string;
declare function markPersisted(id: string): void;
/** Mark many ids persisted (e.g. host app list without per-key `key(..., { persist })`). */
declare function markPersistedIds(ids: string[]): void;
declare function isPersisted(id: string): boolean;
declare function isShared(id: string): boolean;
declare function persistedIds(): string[];
declare function storageKey(id: string): string;
declare function readPersisted(id: string): unknown | undefined;

/** Nanoid-style id, length 21, via crypto.getRandomValues. */
declare function uuid(size?: number): string;

declare function get<T = unknown>(key: AnyKey): T | undefined;
declare function set<T = unknown>(key: AnyKey, value: T | ((prev: T | undefined) => T)): void;
declare function subscribe(key: AnyKey, listener: (value: unknown) => void): () => void;
/**
 * Re-read persisted keys from localStorage into the live store.
 * Normally automatic; useful after login or manual storage edits.
 */
declare function hydratePersisted(): void;
/**
 * Remove `persist: true` entries from localStorage (`active-state:KEY`).
 * Omit `key` to clear every persisted id. Does not change in-memory bus values.
 */
declare function clearPersisted(key?: AnyKey | AnyKey[]): void;
declare function reset(): void;

export { type AnyKey, type EventBus, type InitOptions, type KeyPrimitive, type KeySlice, type Observable, type Observer, STORAGE_PREFIX, assertUppercaseId, catalog, clearPersisted, clearRegistry, createEventBus, createObservable, get, getServerSnapshot, getSsr, getStateInstance, getStoragePrefix, hydratePersisted, init, isPersisted, isShared, isUppercaseId, key, markPersisted, markPersistedIds, persistedIds, readPersisted, registeredState, reset, resolveKey, set, storageKey, subscribe, uuid };
