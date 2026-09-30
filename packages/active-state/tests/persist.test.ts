import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  clearPersisted,
  get,
  getStateInstance,
  hydratePersisted,
  init,
  key,
  registeredState,
  reset,
  set,
  STORAGE_PREFIX,
  storageKey,
  subscribe,
} from "../src/core";
import { applyStoragePayload } from "../src/core/persist";

function installMemoryLocalStorage() {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: globalThis.addEventListener?.bind(globalThis),
      removeEventListener: globalThis.removeEventListener?.bind(globalThis),
      dispatchEvent: globalThis.dispatchEvent?.bind(globalThis),
    },
    configurable: true,
    writable: true,
  });
}

beforeAll(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  reset();
  globalThis.localStorage.clear();
});

describe("key({ persist: true })", () => {
  test("writes to localStorage on set", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState());
    set("THEME", { dark: true });
    expect(localStorage.getItem(storageKey("THEME"))).toBe(
      JSON.stringify({ dark: true }),
    );
    expect(storageKey("THEME")).toBe(`${STORAGE_PREFIX}THEME`);
  });

  test("writes to localStorage on getStateInstance().update", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState());
    getStateInstance().update("THEME", { dark: true });
    expect(localStorage.getItem("active-state:THEME")).toBe(
      JSON.stringify({ dark: true }),
    );
  });

  test("rehydrates on init without ssr", () => {
    localStorage.setItem(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
    );
    key("THEME", { dark: false }, { persist: true });
    init(registeredState());
    expect(get("THEME")).toEqual({ dark: true });
  });

  test("with ssr, stays at defaults until hydratePersisted", () => {
    localStorage.setItem(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
    );
    key("THEME", { dark: false }, { persist: true });
    init(registeredState(), { ssr: true });
    expect(get("THEME")).toEqual({ dark: false });
    hydratePersisted();
    expect(get("THEME")).toEqual({ dark: true });
  });

  test("storagePrefix customizes localStorage keys", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState(), { storagePrefix: "app.localState:" });
    set("THEME", { dark: true });
    expect(localStorage.getItem("app.localState:THEME")).toBe(
      JSON.stringify({ dark: true }),
    );
    expect(localStorage.getItem("active-state:THEME")).toBeNull();
    expect(storageKey("THEME")).toBe("app.localState:THEME");
  });

  test("sharePersisted enables cross-tab for all persist keys", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState(), { sharePersisted: true });

    applyStoragePayload(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
      localStorage,
    );

    expect(get("THEME")).toEqual({ dark: true });
  });

  test("persistIds marks host keys without key(persist)", () => {
    init(
      { THEME: { dark: false } },
      { persistIds: ["THEME"] },
    );
    set("THEME", { dark: true });
    expect(localStorage.getItem(storageKey("THEME"))).toBe(
      JSON.stringify({ dark: true }),
    );
  });

  test("corrupt localStorage entry is removed", () => {
    key("THEME", { dark: false }, { persist: true });
    localStorage.setItem("active-state:THEME", "{not-json");
    init(registeredState());
    expect(localStorage.getItem("active-state:THEME")).toBeNull();
    expect(get("THEME")).toEqual({ dark: false });
  });

  test("bus.observables is exposed", () => {
    init({ COUNT: 0 });
    expect(getStateInstance().observables.get("COUNT")?.getValue()).toBe(0);
  });

  test("hydratePersisted can be called manually", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState());
    localStorage.setItem(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
    );
    hydratePersisted();
    expect(get("THEME")).toEqual({ dark: true });
  });

  test("non-persist keys stay out of storage", () => {
    key("LAYOUT", { nav: false });
    init(registeredState());
    set("LAYOUT", { nav: true });
    expect(localStorage.getItem("active-state:LAYOUT")).toBeNull();
  });

  test("clearPersisted removes storage without clearing bus", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState());
    set("THEME", { dark: true });
    clearPersisted("THEME");
    expect(localStorage.getItem("active-state:THEME")).toBeNull();
    expect(get("THEME")).toEqual({ dark: true });
  });

  test("clearPersisted() clears all persisted keys", () => {
    key("THEME", { dark: false }, { persist: true });
    key("LOCALE", "en", { persist: true });
    init(registeredState());
    set("THEME", { dark: true });
    set("LOCALE", "fr");
    clearPersisted();
    expect(localStorage.getItem("active-state:THEME")).toBeNull();
    expect(localStorage.getItem("active-state:LOCALE")).toBeNull();
  });

  test("shared: true applies storage events from other tabs", () => {
    key("THEME", { dark: false }, { persist: true, shared: true });
    init(registeredState());

    let seen: unknown;
    subscribe("THEME", (value) => {
      seen = value;
    });

    localStorage.setItem(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
    );
    applyStoragePayload(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
      localStorage,
    );

    expect(get("THEME")).toEqual({ dark: true });
    expect(seen).toEqual({ dark: true });
  });

  test("persist without shared ignores cross-tab storage events", () => {
    key("THEME", { dark: false }, { persist: true });
    init(registeredState());

    applyStoragePayload(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
      localStorage,
    );

    expect(get("THEME")).toEqual({ dark: false });
  });

  test("shared: true alone implies persist", () => {
    key("THEME", { dark: false }, { shared: true });
    init(registeredState());
    set("THEME", { dark: true });
    expect(localStorage.getItem("active-state:THEME")).toBe(
      JSON.stringify({ dark: true }),
    );
  });
});

