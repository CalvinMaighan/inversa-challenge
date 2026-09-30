import { describe, expect, test } from "bun:test";

import { STORAGE_PREFIX, themeBootstrapScript } from "client/themes/bootstrap";
import { accentVars, DEFAULT_ACCENT, DEFAULT_MODE } from "client/themes/palette";

/** Run the inline script against a fake <html> and localStorage, the only globals it touches. */
function run(stored: Record<string, string>, opts: { throwingStorage?: boolean } = {}) {
  const attrs: Record<string, string> = {};
  const vars: Record<string, string> = {};
  const documentElement = {
    setAttribute: (name: string, value: string) => void (attrs[name] = value),
    style: { setProperty: (name: string, value: string) => void (vars[name] = value) },
  };
  const localStorage = {
    getItem: (k: string) => {
      if (opts.throwingStorage) throw new Error("SecurityError");
      return stored[k] ?? null;
    },
  };
  new Function("document", "localStorage", themeBootstrapScript())({ documentElement }, localStorage);
  return { attrs, vars };
}

describe("theme bootstrap script", () => {
  test("uses the active-state prefix Providers passes to <ActiveState />", () => {
    expect(STORAGE_PREFIX).toBe("inversa:");
    expect(themeBootstrapScript()).toContain('"p":"inversa:"');
  });

  test("applies the persisted mode and accent, JSON-encoded as active-state writes them", () => {
    const { attrs, vars } = run({ "inversa:THEME": '"tactical"', "inversa:ACCENT_COLOR": '"gold"' });
    expect(attrs).toEqual({ "data-theme": "tactical", "data-accent": "gold" });
    expect(vars).toEqual(accentVars("gold"));
  });

  test("each of the three modes round-trips", () => {
    for (const mode of ["light", "dark", "tactical"]) {
      expect(run({ "inversa:THEME": JSON.stringify(mode) }).attrs["data-theme"]).toBe(mode);
    }
  });

  test("falls back to the defaults for missing, unknown or corrupt values", () => {
    const fresh = run({});
    expect(fresh.attrs).toEqual({ "data-theme": DEFAULT_MODE, "data-accent": DEFAULT_ACCENT });
    expect(fresh.vars).toEqual(accentVars(DEFAULT_ACCENT));
    expect(run({ "inversa:THEME": '"system"', "inversa:ACCENT_COLOR": '"toString"' }).attrs).toEqual({
      "data-theme": DEFAULT_MODE,
      "data-accent": DEFAULT_ACCENT,
    });
    expect(run({ "inversa:THEME": "{not json" }).attrs["data-theme"]).toBe(DEFAULT_MODE);
  });

  test("survives storage that throws (blocked cookies, sandboxed frames)", () => {
    expect(run({}, { throwingStorage: true }).attrs["data-theme"]).toBe(DEFAULT_MODE);
  });

  test("ignores other prefixes", () => {
    expect(run({ "active-state:THEME": '"light"' }).attrs["data-theme"]).toBe(DEFAULT_MODE);
  });
});
