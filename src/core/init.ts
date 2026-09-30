import { createEventBus, type EventBus } from "./create-event-bus";
import { createObservable } from "./create-observable";
import { getStateInstance } from "./get-state-instance";
import { assertUppercaseId } from "./key-format";
import { setEnforceKeys, setServerSnapshot, setSsr } from "./options";
import {
  applyPersistedToState,
  isPersisted,
  markPersistedIds,
  setStoragePrefix,
  shareAllPersisted,
  startStorageSync,
  writePersisted,
} from "./persist";

export type InitOptions = {
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

/** Persist on every bus write (set, update, helpers) for `persist: true` keys. */
function installPersistBridge(bus: EventBus): void {
  const baseUpdate = bus.update.bind(bus);
  bus.update = (id, value) => {
    baseUpdate(id, value);
    if (isPersisted(id)) writePersisted(id, value);
  };
}

export function init(
  initialState: Record<string, unknown>,
  options: InitOptions = {},
): void {
  try {
    getStateInstance();
    return;
  } catch {
    // continue
  }

  const allowAny = options.any ?? false;
  const enableSsr = options.ssr ?? false;
  setEnforceKeys(!allowAny);
  setSsr(enableSsr);

  if (options.storagePrefix != null) {
    setStoragePrefix(options.storagePrefix);
  }

  if (options.persistIds?.length) {
    markPersistedIds(options.persistIds);
  }

  if (options.sharePersisted) {
    shareAllPersisted();
  }

  // Server snapshot always uses the provided defaults (no localStorage).
  setServerSnapshot(initialState);

  if (!allowAny) {
    for (const key of Object.keys(initialState)) {
      assertUppercaseId(key);
    }
  }

  // Client-only apps: merge storage before the bus exists (no hydration mismatch).
  const bootState = enableSsr
    ? initialState
    : applyPersistedToState(initialState);

  const bus = createEventBus({
    init(observables) {
      for (const key of Object.keys(bootState)) {
        observables.set(key, createObservable(bootState[key]));
      }
    },
  });
  installPersistBridge(bus);
  getStateInstance(bus);

  startStorageSync((id, value) => {
    bus.update(id, value);
  });

  // SSR: do not hydrate here — `<ActiveState ssr />` runs hydratePersisted in
  // useLayoutEffect (pre-paint). Non-React hosts should call hydratePersisted().
}
