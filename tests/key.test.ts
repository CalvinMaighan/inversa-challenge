import { afterEach, describe, expect, test } from "bun:test";
import {
  ActiveState,
} from "../src/react/active-state";
import {
  catalog,
  key,
  registeredState,
  reset,
  resolveKey,
} from "../src/core";

afterEach(() => {
  reset();
});

describe("key()", () => {
  test("builds $ and field paths", () => {
    const LAYOUT = key("LAYOUT", { nav: false });
    expect(LAYOUT.$).toBe("LAYOUT");
    expect(LAYOUT.nav).toBe("LAYOUT.nav");
    expect(LAYOUT.defaults).toEqual({ nav: false });
  });

  test("supports primitive defaults", () => {
    const THEME = key("THEME", "system" as "system" | "dark");
    expect(THEME.$).toBe("THEME");
    expect(THEME.defaults).toBe("system");
  });

  test("rejects bad ids unless any", () => {
    expect(() => key("layout", { nav: false })).toThrow(/Invalid key/);
    const layout = key("layout", { nav: false }, { any: true });
    expect(layout.$).toBe("layout");
  });

  test("auto-registers into ActiveState.state", () => {
    const USER = key("USER", { id: null as string | null });
    const LAYOUT = key("LAYOUT", { nav: false });
    expect(registeredState()).toEqual({
      USER: { id: null },
      LAYOUT: { nav: false },
    });
    expect(ActiveState.state).toEqual(registeredState());
    expect(catalog()).toEqual(registeredState());
    expect(catalog(USER, LAYOUT)).toEqual({
      USER: { id: null },
      LAYOUT: { nav: false },
    });
    expect(resolveKey(LAYOUT)).toBe("LAYOUT");
    expect(resolveKey(LAYOUT.$)).toBe("LAYOUT");
  });
});
