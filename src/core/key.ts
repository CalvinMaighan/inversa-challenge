import { assertUppercaseId } from "./key-format";
import { clearPersistedIds, markPersisted, markShared } from "./persist";

export type KeySlice<
  K extends string,
  T extends Record<string, unknown>,
> = {
  readonly $: K;
  readonly defaults: T;
} & { readonly [P in keyof T & string]: `${K}.${P}` };

export type KeyPrimitive<K extends string, T> = {
  readonly $: K;
  readonly defaults: T;
};

export type AnyKey =
  | string
  | { readonly $: string };

const registry = new Map<string, unknown>();

/** Resolve a key string or a `key()` slice to the store id. */
export function resolveKey(input: AnyKey): string {
  return typeof input === "string" ? input : input.$;
}

/** Snapshot of every `key()` registration (for init / ActiveState.state). */
export function registeredState(): Record<string, unknown> {
  return Object.fromEntries(registry);
}

export function clearRegistry(): void {
  registry.clear();
  clearPersistedIds();
}

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
export function key<K extends string, T extends Record<string, unknown>>(
  id: K,
  defaults: T,
  options?: KeyOptions,
): KeySlice<K, T>;
export function key<K extends string, T>(
  id: K,
  defaults: T,
  options?: KeyOptions,
): KeyPrimitive<K, T>;
export function key<K extends string, T>(
  id: K,
  defaults: T,
  options: KeyOptions = {},
): KeySlice<K, any> | KeyPrimitive<K, T> {
  if (!options.any) assertUppercaseId(id);

  registry.set(id, defaults);
  if (options.persist || options.shared) markPersisted(id);
  if (options.shared) markShared(id);

  if (
    defaults != null &&
    typeof defaults === "object" &&
    !Array.isArray(defaults)
  ) {
    const slice = { $: id, defaults } as KeySlice<K, Record<string, unknown>>;
    for (const field of Object.keys(defaults as object)) {
      (slice as Record<string, string>)[field] = `${id}.${field}`;
    }
    return slice as KeySlice<K, any>;
  }

  return { $: id, defaults };
}

/**
 * Build an init object from slices.
 * With no arguments, returns the auto-registered map (same as ActiveState.state).
 */
export function catalog(
  ...slices: Array<{ readonly $: string; readonly defaults: unknown }>
): Record<string, unknown> {
  if (slices.length === 0) return registeredState();

  const state: Record<string, unknown> = {};
  for (const slice of slices) {
    state[slice.$] = slice.defaults;
  }
  return state;
}


