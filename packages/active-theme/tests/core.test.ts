import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  applyMode,
  defineTheme,
  hydrateTheme,
  readModeFromDocument,
  readStoredMode,
  resetThemeRuntime,
  setColor,
  setMode,
} from "../src/core";

function installDom() {
  const styles = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const el = {
    dataset,
    style: {
      setProperty(name: string, value: string) {
        styles.set(name, value);
      },
      getPropertyValue(name: string) {
        return styles.get(name) ?? "";
      },
    },
  };

  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => map.set(k, String(v)),
      removeItem: (k: string) => map.delete(k),
      clear: () => map.clear(),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: el },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    configurable: true,
  });
}

beforeAll(() => {
  installDom();
});

afterEach(() => {
  resetThemeRuntime();
  localStorage.clear();
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.accent;
});

describe("active-theme core", () => {
  test("defineTheme + setMode persists and sets data-theme", () => {
    const theme = defineTheme({
      defaultColor: "orange",
      colors: { orange: { hue: 58 }, blue: { hue: 236 } },
    });
    setMode("light", theme);
    expect(readModeFromDocument()).toBe("light");
    expect(readStoredMode(theme)).toBe("light");
    expect(localStorage.getItem("active-theme:mode")).toBe("light");
  });

  test("setColor writes accent + hue vars", () => {
    const theme = defineTheme({
      defaultColor: "orange",
      colors: { orange: { hue: 58 }, blue: { hue: 236 } },
    });
    setColor("blue", theme);
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(document.documentElement.style.getPropertyValue("--hue")).toBe(
      "236",
    );
  });

  test("hydrateTheme restores from storage", () => {
    localStorage.setItem("active-theme:mode", "light");
    localStorage.setItem("active-theme:color", "blue");
    const theme = defineTheme({
      defaultColor: "orange",
      colors: { orange: { hue: 58 }, blue: { hue: 236 } },
    });
    hydrateTheme(theme);
    expect(readModeFromDocument()).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("blue");
  });

  test("applyMode works without persist", () => {
    const theme = defineTheme({
      defaultColor: "orange",
      colors: { orange: { hue: 58 } },
      persist: false,
    });
    applyMode(theme, "light");
    expect(readModeFromDocument()).toBe("light");
    expect(localStorage.getItem("active-theme:mode")).toBeNull();
  });
});
