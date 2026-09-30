import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  get,
  hydratePersisted,
  init,
  key,
  registeredState,
  reset,
  set,
} from "../src/core";
import { ActiveState } from "../src/react/active-state";
import { useActiveState } from "../src/react/use-active-state";
import { useLocalState } from "../src/react/use-local-state";

let happy: Window;

beforeAll(() => {
  happy = new Window({ url: "https://example.com" });
  Object.defineProperty(globalThis, "window", {
    value: happy,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: happy.document,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: happy.localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: happy.navigator,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: happy.HTMLElement,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    value: happy.MutationObserver,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  reset();
  happy.localStorage.clear();
});

describe("useActiveState", () => {
  test("subscribes and updates", () => {
    key("COUNT", 0);
    init(registeredState());

    let latest: number | undefined;
    function Probe() {
      const [count] = useActiveState<number>("COUNT");
      latest = count;
      return null;
    }

    const el = document.createElement("div");
    document.body.appendChild(el);
    let root: Root;
    act(() => {
      root = createRoot(el);
      root.render(createElement(Probe));
    });
    expect(latest).toBe(0);

    act(() => {
      set("COUNT", 2);
    });
    expect(latest).toBe(2);

    act(() => {
      root!.unmount();
    });
    el.remove();
  });

  test("selector skips when selected value Object.is-equal", () => {
    key("BOX", { x: 1, y: 2 });
    init(registeredState());

    let renders = 0;
    let latest: number | undefined;
    function Probe() {
      const [x] = useActiveState("BOX", (v: { x: number; y: number }) => v.x);
      renders += 1;
      latest = x;
      return null;
    }

    const el = document.createElement("div");
    document.body.appendChild(el);
    let root: Root;
    act(() => {
      root = createRoot(el);
      root.render(createElement(Probe));
    });
    const afterMount = renders;

    act(() => {
      set("BOX", { x: 1, y: 99 });
    });
    expect(latest).toBe(1);
    expect(renders).toBe(afterMount);

    act(() => {
      set("BOX", { x: 3, y: 99 });
    });
    expect(latest).toBe(3);
    expect(renders).toBeGreaterThan(afterMount);

    act(() => {
      root!.unmount();
    });
    el.remove();
  });
});

describe("ActiveState ssr hydrate", () => {
  test("useLayoutEffect hydrates persisted keys", () => {
    localStorage.setItem(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
    );
    key("THEME", { dark: false }, { persist: true });
    const state = registeredState();

    const el = document.createElement("div");
    document.body.appendChild(el);
    let root: Root;
    act(() => {
      root = createRoot(el);
      root.render(createElement(ActiveState, { init: state, ssr: true }));
    });

    expect(get<unknown>("THEME")).toEqual({ dark: true });

    act(() => {
      root!.unmount();
    });
    el.remove();
  });
});

describe("useLocalState compat", () => {
  test("throws on json: false", () => {
    key("RAW", "x", { persist: true });
    init(registeredState(), { ssr: true });

    expect(() => {
      useLocalState("RAW", { json: false });
    }).toThrow(/json: false/);
  });

  test("hydrationSafe reads after hydratePersisted", () => {
    localStorage.setItem(
      "active-state:THEME",
      JSON.stringify({ dark: true }),
    );
    key("THEME", { dark: false }, { persist: true });
    init(registeredState(), { ssr: true });
    hydratePersisted();

    let latest: { dark: boolean } | undefined;
    function Probe() {
      const [theme] = useLocalState<{ dark: boolean }>("THEME", {
        hydrationSafe: true,
      });
      latest = theme;
      return null;
    }

    const el = document.createElement("div");
    document.body.appendChild(el);
    let root: Root;
    act(() => {
      root = createRoot(el);
      root.render(createElement(Probe));
    });
    expect(latest).toEqual({ dark: true });

    act(() => {
      root!.unmount();
    });
    el.remove();
  });
});
