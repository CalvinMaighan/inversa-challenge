import { describe, expect, test } from "bun:test";

import {
  ACCENT_IDS,
  ACCENTS,
  accentVars,
  COLOR_TOKENS,
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  isThemeMode,
  modeDeclarations,
  PALETTES,
  sharedDeclarations,
  THEME_MODES,
} from "client/themes/palette";

/** oklch() with numeric L C H, a var()-driven accent, or a shadow. Rejects hex and rgb for colour tokens. */
const OKLCH = /^oklch\((?:[\d.]+|var\(--[a-z-]+\)) (?:[\d.]+|var\(--[a-z-]+\)) (?:[\d.]+|var\(--[a-z-]+\))(?: \/ [\d.]+)?\)$/;

describe("theme modes", () => {
  test("are light, dark and tactical, with dark the default", () => {
    expect(THEME_MODES).toEqual(["light", "dark", "tactical"]);
    expect(DEFAULT_MODE).toBe("dark");
    expect(isThemeMode("tactical")).toBe(true);
    expect(isThemeMode("system")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });

  test("every mode defines every semantic token", () => {
    for (const mode of THEME_MODES) {
      expect(Object.keys(PALETTES[mode].colors).sort()).toEqual([...COLOR_TOKENS].sort());
    }
  });

  test("colour tokens are OKLCH", () => {
    for (const mode of THEME_MODES) {
      for (const token of COLOR_TOKENS) {
        if (token === "shadow") continue;
        expect(PALETTES[mode].colors[token]).toMatch(OKLCH);
      }
    }
  });

  test("light and dark keep big-value's ported values", () => {
    expect(PALETTES.light.colors.bg).toBe("oklch(1 0 0)"); // #ffffff
    expect(PALETTES.light.colors.text).toBe("oklch(0.189 0.003 17.4)"); // #151313
    expect(PALETTES.dark.colors.bg).toBe("oklch(0.225 0.01 294.8)"); // #1c1b20
    expect(PALETTES.dark.colors.warn).toBe("oklch(0.834 0.141 85.4)"); // #f2c14e
  });

  test("light and dark accents follow active-theme's vars; tactical pins phosphor green", () => {
    expect(PALETTES.light.colors.accent).toContain("var(--hue-accent)");
    expect(PALETTES.dark.colors.accent).toContain("var(--chroma-accent)");
    expect(PALETTES.tactical.colors.accent).not.toContain("var(");
    expect(PALETTES.tactical.colors.accent).toBe(PALETTES.tactical.colors.ok);
  });

  test("tactical is a dark scheme with amber warnings and a mono UI face", () => {
    expect(PALETTES.tactical.colorScheme).toBe("dark");
    const warnHue = Number(PALETTES.tactical.colors.warn.match(/oklch\([\d.]+ [\d.]+ ([\d.]+)/)?.[1]);
    expect(warnHue).toBeGreaterThanOrEqual(60);
    expect(warnHue).toBeLessThanOrEqual(85);
    expect(modeDeclarations("tactical")).toContain("--font-ui: var(--font-mono);");
    expect(modeDeclarations("dark")).not.toContain("--font-ui");
  });

  test("text contrasts with the background in every mode (OKLCH lightness gap ≥ 0.6)", () => {
    const lightness = (v: string) => Number(v.match(/^oklch\(([\d.]+)/)?.[1]);
    for (const mode of THEME_MODES) {
      const { bg, text } = PALETTES[mode].colors;
      expect(Math.abs(lightness(text) - lightness(bg))).toBeGreaterThanOrEqual(0.6);
    }
  });
});

describe("accents", () => {
  test("reproduce big-value's crimson and gold through active-theme's formula", () => {
    expect(ACCENT_IDS).toEqual(["crimson", "gold", "signal"]);
    expect(DEFAULT_ACCENT).toBe("crimson");
    const crimson = accentVars("crimson");
    expect(Number(crimson["--hue-accent"])).toBeCloseTo(24.3, 5);
    expect(Number(crimson["--chroma-accent"])).toBeCloseTo(0.156, 3);
    const gold = accentVars("gold");
    expect(Number(gold["--hue-accent"])).toBeCloseTo(85.4, 5);
    expect(Number(gold["--chroma-accent"])).toBeCloseTo(0.141, 3);
    expect(accentVars("signal")["--hue"]).toBe(String(ACCENTS.signal.hue));
  });
});

describe("declarations", () => {
  test("modeDeclarations emits color-scheme and one custom property per token", () => {
    for (const mode of THEME_MODES) {
      const css = modeDeclarations(mode);
      expect(css).toContain(`color-scheme: ${PALETTES[mode].colorScheme};`);
      for (const token of COLOR_TOKENS) expect(css).toContain(`--${token}: ${PALETTES[mode].colors[token]};`);
    }
  });

  test("sharedDeclarations carries fonts, scale and the default accent vars", () => {
    const css = sharedDeclarations();
    expect(css).toContain("--font-sans: var(--font-inter");
    expect(css).toContain("--font-mono: var(--font-jetbrains-mono");
    expect(css).toContain(`--hue: ${ACCENTS[DEFAULT_ACCENT].hue};`);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)/);
  });
});
