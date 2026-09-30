import { afterEach, describe, expect, test } from "bun:test";
import {
  createObservable,
  get,
  init,
  isUppercaseId,
  reset,
  set,
  subscribe,
} from "../src/core";

afterEach(() => {
  reset();
});

describe("createObservable", () => {
  test("subscribe gets current value immediately", () => {
    const obs = createObservable(1);
    let seen: number | undefined;
    obs.subscribe({
      id: "a",
      next: (v) => {
        seen = v as number;
      },
      complete: () => {},
    });
    expect(seen).toBe(1);
  });

  test("Object.is skips notify", () => {
    const obj = { n: 1 };
    const obs = createObservable(obj);
    let calls = 0;
    obs.subscribe({
      id: "a",
      next: () => {
        calls++;
      },
      complete: () => {},
    });
    obs.next(obj);
    expect(calls).toBe(1);
    obs.next({ n: 1 });
    expect(calls).toBe(2);
  });

  test("unsubscribe stops updates", () => {
    const obs = createObservable(0);
    let last = -1;
    obs.subscribe({
      id: "a",
      next: (v) => {
        last = v as number;
      },
      complete: () => {},
    });
    obs.unsubscribe("a");
    obs.next(5);
    expect(last).toBe(0);
  });
});

describe("key format", () => {
  test("accepts UPPERCASE_IDS", () => {
    expect(isUppercaseId("CART")).toBe(true);
    expect(isUppercaseId("CART_ITEMS")).toBe(true);
    expect(isUppercaseId("UI_NAV_OPEN")).toBe(true);
    expect(isUppercaseId("cart")).toBe(false);
    expect(isUppercaseId("CART-ITEMS")).toBe(false);
    expect(isUppercaseId("_CART")).toBe(false);
  });
});

describe("core", () => {
  test("get before init throws", () => {
    expect(() => get("X")).toThrow(/not been initialized/);
  });

  test("init is idempotent", () => {
    init({ COUNT: 0 });
    init({ COUNT: 99 });
    expect(get<number>("COUNT")).toBe(0);
  });

  test("get/set after init", () => {
    init({ COUNT: 0 });
    set("COUNT", 2);
    expect(get<number>("COUNT")).toBe(2);
  });

  test("set with updater fn", () => {
    init({ COUNT: 1 });
    set<number>("COUNT", (c) => (c ?? 0) + 1);
    expect(get<number>("COUNT")).toBe(2);
  });

  test("subscribe notifies", () => {
    init({ MESSAGE: "hi" });
    const values: unknown[] = [];
    const unsub = subscribe("MESSAGE", (v) => values.push(v));
    set("MESSAGE", "yo");
    unsub();
    set("MESSAGE", "nope");
    expect(values).toEqual(["hi", "yo"]);
  });

  test("reset clears singleton", () => {
    init({ COUNT: 1 });
    reset();
    expect(() => get("COUNT")).toThrow(/not been initialized/);
  });

  test("unknown key warns", () => {
    init({ COUNT: 0 });
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      get("MISSING");
      set("ALSO_MISSING", 1);
      expect(String(warnings[0]?.[0])).toMatch(/Unknown key "MISSING"/);
      expect(String(warnings[1]?.[0])).toMatch(/Unknown key "ALSO_MISSING"/);
    } finally {
      console.warn = original;
    }
  });

  test("rejects non UPPERCASE_IDS by default", () => {
    expect(() => init({ count: 0 })).toThrow(/Invalid key "count"/);
  });

  test("any: true allows any key", () => {
    init({ count: 0 }, { any: true });
    set("count", 1);
    expect(get<number>("count")).toBe(1);
  });
});


