// src/core/get-state-instance.ts
var globalStateInstance = null;
function getStateInstance(bus) {
  if (bus) {
    globalStateInstance = bus;
    return bus;
  }
  if (!globalStateInstance) {
    throw new Error(
      "State has not been initialized. Call init(initialState) first."
    );
  }
  return globalStateInstance;
}
function resetStateInstance() {
  globalStateInstance = null;
}

// src/core/create-observable.ts
function createObservable(initial) {
  let value = initial;
  const subscribers = /* @__PURE__ */ new Map();
  return {
    subscribe(observer) {
      subscribers.set(observer.id, observer);
      observer.next(value);
    },
    unsubscribe(id) {
      subscribers.delete(id);
    },
    next(nextValue) {
      if (Object.is(value, nextValue)) return;
      value = nextValue;
      for (const observer of subscribers.values()) {
        observer.next(value);
      }
    },
    complete() {
      for (const observer of subscribers.values()) {
        observer.complete();
      }
      subscribers.clear();
    },
    getValue() {
      return value;
    }
  };
}

// src/core/create-event-bus.ts
function createEventBus(options = {}) {
  const observables = /* @__PURE__ */ new Map();
  options.init?.(observables);
  return {
    observables,
    getSource(id) {
      const source = observables.get(id);
      if (!source) {
        console.warn(
          `[active-state] Unknown key "${id}". Add it to your init object (e.g. client/state).`
        );
        return void 0;
      }
      return source;
    },
    update(id, value) {
      let source = observables.get(id);
      if (!source) {
        console.warn(
          `[active-state] Unknown key "${id}". Add it to your init object (e.g. client/state).`
        );
        source = createObservable(value);
        observables.set(id, source);
        source.next(value);
        return;
      }
      source.next(value);
    },
    keys() {
      return [...observables.keys()];
    }
  };
}

// src/core/key-format.ts
var UPPERCASE_ID = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
function isUppercaseId(key2) {
  return UPPERCASE_ID.test(key2);
}
function assertUppercaseId(key2) {
  if (!isUppercaseId(key2)) {
    throw new Error(
      `[active-state] Invalid key "${key2}". Use UPPERCASE_IDS (e.g. CART_ITEMS). Pass any on <ActiveState> (or init(..., { any: true })) to allow any keys.`
    );
  }
}

// src/core/options.ts
var enforceKeys = true;
var ssr = false;
var serverSnapshot = {};
function setEnforceKeys(value) {
  enforceKeys = value;
}
function getEnforceKeys() {
  return enforceKeys;
}
function setSsr(value) {
  ssr = value;
}
function getSsr() {
  return ssr;
}
function setServerSnapshot(state) {
  serverSnapshot = { ...state };
}
function getServerSnapshot(key2) {
  return serverSnapshot[key2];
}
function resetOptions() {
  enforceKeys = true;
  ssr = false;
  serverSnapshot = {};
}

// src/core/persist.ts
var STORAGE_PREFIX = "active-state:";
var storagePrefix = STORAGE_PREFIX;
var persistIds = /* @__PURE__ */ new Set();
var sharedIds = /* @__PURE__ */ new Set();
var suppressPersistWrite = false;
function getStoragePrefix() {
  return storagePrefix;
}
function setStoragePrefix(prefix) {
  storagePrefix = prefix;
}
function markPersisted(id) {
  persistIds.add(id);
}
function markShared(id) {
  sharedIds.add(id);
}
function markPersistedIds(ids) {
  for (const id of ids) persistIds.add(id);
}
function shareAllPersisted() {
  for (const id of persistIds) sharedIds.add(id);
}
function clearPersistedIds() {
  persistIds.clear();
  sharedIds.clear();
}
function resetPersistRuntime() {
  clearPersistedIds();
  storagePrefix = STORAGE_PREFIX;
  suppressPersistWrite = false;
  stopStorageSync();
}
function isPersisted(id) {
  return persistIds.has(id);
}
function isShared(id) {
  return sharedIds.has(id);
}
function persistedIds() {
  return [...persistIds];
}
function storageKey(id) {
  return getStoragePrefix() + id;
}
function canUseStorage() {
  return typeof globalThis.localStorage !== "undefined";
}
function readPersisted(id) {
  if (!canUseStorage()) return void 0;
  const sk = storageKey(id);
  try {
    const raw = globalThis.localStorage.getItem(sk);
    if (raw == null) return void 0;
    return JSON.parse(raw);
  } catch {
    try {
      globalThis.localStorage.removeItem(sk);
    } catch {
    }
    return void 0;
  }
}
function writePersisted(id, value) {
  if (suppressPersistWrite || !canUseStorage()) return;
  try {
    globalThis.localStorage.setItem(storageKey(id), JSON.stringify(value));
  } catch {
  }
}
function removePersisted(ids) {
  if (!canUseStorage()) return;
  const list = ids === void 0 ? persistedIds() : Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    try {
      globalThis.localStorage.removeItem(storageKey(id));
    } catch {
    }
  }
}
function applyPersistedToState(state) {
  if (!canUseStorage() || persistIds.size === 0) return state;
  const next = { ...state };
  for (const id of persistIds) {
    if (!(id in next)) continue;
    const stored = readPersisted(id);
    if (stored !== void 0) next[id] = stored;
  }
  return next;
}
function withoutPersistWrite(fn) {
  suppressPersistWrite = true;
  try {
    fn();
  } finally {
    suppressPersistWrite = false;
  }
}
var stopSync = null;
var applyRemote = null;
function applyStoragePayload(key2, newValue, storageArea) {
  if (!applyRemote) return;
  if (storageArea != null && typeof globalThis.localStorage !== "undefined" && storageArea !== globalThis.localStorage) {
    return;
  }
  const prefix = getStoragePrefix();
  if (!key2 || !key2.startsWith(prefix) || newValue == null) return;
  const id = key2.slice(prefix.length);
  if (!isShared(id)) return;
  try {
    const parsed = JSON.parse(newValue);
    withoutPersistWrite(() => applyRemote(id, parsed));
  } catch {
  }
}
function startStorageSync(apply) {
  stopStorageSync();
  applyRemote = apply;
  if (sharedIds.size === 0) return;
  const win = globalThis.window;
  if (typeof win === "undefined" || typeof win.addEventListener !== "function") {
    return;
  }
  const onStorage = (event) => {
    const e = event;
    applyStoragePayload(e.key, e.newValue, e.storageArea);
  };
  win.addEventListener("storage", onStorage);
  stopSync = () => win.removeEventListener("storage", onStorage);
}
function stopStorageSync() {
  stopSync?.();
  stopSync = null;
  applyRemote = null;
}

// src/core/init.ts
function installPersistBridge(bus) {
  const baseUpdate = bus.update.bind(bus);
  bus.update = (id, value) => {
    baseUpdate(id, value);
    if (isPersisted(id)) writePersisted(id, value);
  };
}
function init(initialState, options = {}) {
  try {
    getStateInstance();
    return;
  } catch {
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
  setServerSnapshot(initialState);
  if (!allowAny) {
    for (const key2 of Object.keys(initialState)) {
      assertUppercaseId(key2);
    }
  }
  const bootState = enableSsr ? initialState : applyPersistedToState(initialState);
  const bus = createEventBus({
    init(observables) {
      for (const key2 of Object.keys(bootState)) {
        observables.set(key2, createObservable(bootState[key2]));
      }
    }
  });
  installPersistBridge(bus);
  getStateInstance(bus);
  startStorageSync((id, value) => {
    bus.update(id, value);
  });
}

// src/core/uuid.ts
var alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
function uuid(size = 21) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += alphabet[bytes[i] & 63];
  }
  return id;
}

// src/core/key.ts
var registry = /* @__PURE__ */ new Map();
function resolveKey(input) {
  return typeof input === "string" ? input : input.$;
}
function registeredState() {
  return Object.fromEntries(registry);
}
function clearRegistry() {
  registry.clear();
  clearPersistedIds();
}
function key(id, defaults, options = {}) {
  if (!options.any) assertUppercaseId(id);
  registry.set(id, defaults);
  if (options.persist || options.shared) markPersisted(id);
  if (options.shared) markShared(id);
  if (defaults != null && typeof defaults === "object" && !Array.isArray(defaults)) {
    const slice = { $: id, defaults };
    for (const field of Object.keys(defaults)) {
      slice[field] = `${id}.${field}`;
    }
    return slice;
  }
  return { $: id, defaults };
}
function catalog(...slices) {
  if (slices.length === 0) return registeredState();
  const state = {};
  for (const slice of slices) {
    state[slice.$] = slice.defaults;
  }
  return state;
}

// src/core/index.ts
function assertKey(key2) {
  if (getEnforceKeys()) assertUppercaseId(key2);
}
function get(key2) {
  const id = resolveKey(key2);
  assertKey(id);
  const source = getStateInstance().getSource(id);
  return source?.getValue();
}
function set(key2, value) {
  const id = resolveKey(key2);
  assertKey(id);
  const bus = getStateInstance();
  const prev = bus.keys().includes(id) ? bus.getSource(id)?.getValue() : void 0;
  const next = typeof value === "function" ? value(prev) : value;
  bus.update(id, next);
}
function subscribe(key2, listener) {
  const id = resolveKey(key2);
  assertKey(id);
  const source = getStateInstance().getSource(id);
  if (!source) return () => {
  };
  const subId = uuid();
  source.subscribe({
    id: subId,
    next: listener,
    complete: () => {
    }
  });
  return () => source.unsubscribe(subId);
}
function hydratePersisted() {
  for (const id of persistedIds()) {
    const stored = readPersisted(id);
    if (stored !== void 0) set(id, stored);
  }
}
function clearPersisted(key2) {
  if (key2 === void 0) {
    removePersisted();
    return;
  }
  const ids = (Array.isArray(key2) ? key2 : [key2]).map(resolveKey);
  removePersisted(ids);
}
function reset() {
  try {
    const bus = getStateInstance();
    for (const key2 of bus.keys()) {
      bus.getSource(key2)?.complete();
    }
  } catch {
  }
  resetPersistRuntime();
  resetStateInstance();
  resetOptions();
  clearRegistry();
}
export {
  STORAGE_PREFIX,
  assertUppercaseId,
  catalog,
  clearPersisted,
  clearRegistry,
  createEventBus,
  createObservable,
  get,
  getServerSnapshot,
  getSsr,
  getStateInstance,
  getStoragePrefix,
  hydratePersisted,
  init,
  isPersisted,
  isShared,
  isUppercaseId,
  key,
  markPersisted,
  markPersistedIds,
  persistedIds,
  readPersisted,
  registeredState,
  reset,
  resolveKey,
  set,
  storageKey,
  subscribe,
  uuid
};
