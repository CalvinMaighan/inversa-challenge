import { describe, expect, test } from "bun:test";

import { ACCENTS, COLOR_TOKENS, DEFAULT_ACCENT, DEFAULT_MODE, THEME_MODES } from "client/themes/palette";
import { emotionTheme, nextMode, theme } from "client/themes/theme";

/** `hud-line` → `hudLine`, `surface-2` → `surface2`. */
const camel = (token: string) => token.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

describe("active-theme definition", () => {
  test("defines light, dark and tactical", () => {
    // active-theme types modes as light | dark; widen to compare against ours.
    expect([...theme.modes] as string[]).toEqual([...THEME_MODES]);
    expect(theme.defaultMode as string).toBe(DEFAULT_MODE);
  });

  test("leaves storage to the active-state bus", () => {
    expect(theme.persist).toBe(false);
    expect(theme.shared).toBe(false);
  });

  test("registers the accent palettes", () => {
    expect(theme.defaultColor).toBe(DEFAULT_ACCENT);
    expect(theme.colors).toEqual(ACCENTS);
  });
});

describe("nextMode", () => {
  test("cycles light → dark → tactical → light", () => {
    expect(nextMode("light")).toBe("dark");
    expect(nextMode("dark")).toBe("tactical");
    expect(nextMode("tactical")).toBe("light");
  });
});

describe("emotion theme", () => {
  test("maps every colour token to its CSS variable", () => {
    const color: Record<string, string> = emotionTheme.color;
    expect(Object.keys(color).sort()).toEqual(COLOR_TOKENS.map(camel).sort());
    for (const token of COLOR_TOKENS) expect(color[camel(token)]).toBe(`var(--${token})`);
  });

  test("carries the required semantic tokens and both fonts", () => {
    for (const k of ["bg", "surface", "text", "muted", "accent", "danger", "warn", "ok", "hudLine", "hudGlow"]) {
      expect(emotionTheme.color).toHaveProperty(k);
    }
    expect(emotionTheme.font).toEqual({ sans: "var(--font-sans)", mono: "var(--font-mono)", ui: "var(--font-ui)" });
  });
});
