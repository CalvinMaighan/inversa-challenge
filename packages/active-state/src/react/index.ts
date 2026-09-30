export {
  catalog,
  clearPersisted,
  key,
  registeredState,
  resolveKey,
  STORAGE_PREFIX,
  storageKey,
} from "active-state";
export { ActiveState, type ActiveStateInit } from "./active-state";
export { useActiveState } from "./use-active-state";
export { useClientState } from "./use-client-state";
export {
  useLocalState,
  type UseLocalStateOptions,
} from "./use-local-state";

/** Alias — clears a persisted key from localStorage. */
export { clearPersisted as clearLocalStateKey } from "active-state";

