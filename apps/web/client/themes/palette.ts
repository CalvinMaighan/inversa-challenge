/**
 * Colour tokens for the three theme modes, in OKLCH.
 *
 * Light and dark are big-value `client/themes/tokens.ts` converted from hex (the comment on each value is the
 * source hex). Tactical is ours: a green-cast near-black with phosphor-green lines and amber warnings, for the
 * field-ops look over the globe.
 *
 * `--accent` in light and dark reads the active-theme vars (`--hue-accent`, `--chroma-accent`), so switching
 * the accent colour repaints without touching the mode. Tactical pins its accent to phosphor green.
 */

export const THEME_MODES = ["light", "dark", "tactical"] as const;
export type ThemeModeId = (typeof THEME_MODES)[number];

export function isThemeMode(value: unknown): value is ThemeModeId {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** Semantic colour tokens. Each becomes `--<token>` on `:root` and `theme.color.<camelCase>` in Emotion. */
export const COLOR_TOKENS = [
  "bg",
  "surface",
  "surface-2",
  "text",
  "muted",
  "border",
  "accent",
  "accent-hover",
  "accent-fg",
  "danger",
  "warn",
  "ok",
  "hud-line",
  "hud-glow",
  "shadow",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export type ModePalette = {
  colorScheme: "light" | "dark";
  colors: Record<ColorToken, string>;
};

/** Accent built from the active-theme vars at a given lightness. */
const accentAt = (lightness: number, alpha?: number) =>
  `oklch(${lightness} var(--chroma-accent) var(--hue-accent)${alpha === undefined ? "" : ` / ${alpha}`})`;

export const PALETTES: Record<ThemeModeId, ModePalette> = {
  light: {
    colorScheme: "light",
    colors: {
      bg: "oklch(1 0 0)", // #ffffff
      surface: "oklch(1 0 0)", // #ffffff (card)
      "surface-2": "oklch(0.981 0.004 56.4)", // #fbf8f6 (card-hover)
      text: "oklch(0.189 0.003 17.4)", // #151313
      muted: "oklch(0.522 0.008 39.4)", // #6e6866
      border: "oklch(0.919 0.008 56.3)", // #e9e3df
      accent: accentAt(0.523), // #b23a3a with the crimson accent
      "accent-hover": accentAt(0.476), // #9d3232
      "accent-fg": "oklch(1 0 0)", // #ffffff
      danger: "oklch(0.523 0.156 24.3)", // #b23a3a
      warn: "oklch(0.563 0.112 76.7)", // #9a6b12 (gold-text, readable on white)
      ok: "oklch(0.52 0.13 150)",
      "hud-line": "oklch(0.189 0.003 17.4 / 0.55)",
      "hud-glow": accentAt(0.523, 0.22),
      shadow: "0 10px 30px rgb(20 10 10 / 8%)",
    },
  },
  dark: {
    colorScheme: "dark",
    colors: {
      bg: "oklch(0.225 0.01 294.8)", // #1c1b20
      surface: "oklch(0.26 0.011 293.3)", // #242329 (card)
      "surface-2": "oklch(0.285 0.013 292.1)", // #2a2930 (card-hover)
      text: "oklch(0.957 0.005 297.7)", // #f1f0f4
      muted: "oklch(0.695 0.016 294.3)", // #9d9ba6
      border: "oklch(0.329 0.014 291.3)", // #35343c
      accent: accentAt(0.6), // #d34b4d with the crimson accent
      "accent-hover": accentAt(0.641), // #e05a5c
      "accent-fg": "oklch(1 0 0)",
      danger: "oklch(0.6 0.172 23.1)", // #d34b4d
      warn: "oklch(0.834 0.141 85.4)", // #f2c14e (gold)
      ok: "oklch(0.72 0.15 150)",
      "hud-line": "oklch(0.957 0.005 297.7 / 0.5)",
      "hud-glow": accentAt(0.6, 0.35),
      shadow: "0 10px 30px rgb(0 0 0 / 35%)",
    },
  },
  tactical: {
    colorScheme: "dark",
    colors: {
      bg: "oklch(0.16 0.012 160)",
      surface: "oklch(0.2 0.016 160)",
      "surface-2": "oklch(0.24 0.02 160)",
      text: "oklch(0.92 0.06 150)",
      muted: "oklch(0.68 0.06 150)",
      border: "oklch(0.36 0.05 150)",
      accent: "oklch(0.82 0.19 148)",
      "accent-hover": "oklch(0.88 0.2 148)",
      "accent-fg": "oklch(0.16 0.012 160)",
      danger: "oklch(0.66 0.2 25)",
      warn: "oklch(0.8 0.16 75)", // amber
      ok: "oklch(0.82 0.19 148)",
      "hud-line": "oklch(0.82 0.19 148 / 0.7)",
      "hud-glow": "oklch(0.82 0.19 148 / 0.45)",
      shadow: "0 0 0 1px oklch(0.82 0.19 148 / 0.25), 0 10px 30px rgb(0 0 0 / 55%)",
    },
  },
};

/**
 * Accent palettes for active-theme. `applyColor` sets `--hue-accent = hue - 3` and
 * `--chroma-accent = chromaBase * 11.111`, so these reproduce the source colours at the lightness in PALETTES.
 */
export const ACCENTS = {
  /** big-value primary, #b23a3a: oklch(0.523 0.156 24.3). */
  crimson: { hue: 27.3, chromaBase: 0.014 },
  /** big-value gold, #f2c14e: oklch(0.834 0.141 85.4). */
  gold: { hue: 88.4, chromaBase: 0.0127 },
  /** Signal green, matches the tactical phosphor hue. */
  signal: { hue: 151, chromaBase: 0.0144 },
} as const;
export type AccentId = keyof typeof ACCENTS;
export const ACCENT_IDS = Object.keys(ACCENTS) as AccentId[];

export const DEFAULT_MODE: ThemeModeId = "dark";
export const DEFAULT_ACCENT: AccentId = "crimson";

/** The four vars active-theme's `applyColor` writes, computed the same way. */
export function accentVars(id: AccentId): Record<"--hue" | "--hue-accent" | "--chroma-base" | "--chroma-accent", string> {
  const { hue, chromaBase } = ACCENTS[id];
  return {
    "--hue": String(hue),
    "--hue-accent": String(hue - 3),
    "--chroma-base": String(chromaBase),
    "--chroma-accent": String(chromaBase * 11.111),
  };
}

/** Mode-independent tokens (scale, radius, fonts). Fonts point at the next/font/local variables from app/layout.tsx. */
export const SHARED_TOKENS: Record<string, string> = {
  "--font-sans": "var(--font-inter, ui-sans-serif), ui-sans-serif, system-ui, sans-serif",
  "--font-mono": "var(--font-jetbrains-mono, ui-monospace), ui-monospace, SFMono-Regular, Menlo, monospace",
  "--font-ui": "var(--font-sans)",
  "--font-xs": "12px",
  "--font-s": "14px",
  "--font-m": "16px",
  "--font-l": "18px",
  "--font-h3": "20px",
  "--font-h2": "28px",
  "--font-h1": "44px",
  "--gap-xs": "4px",
  "--gap-s": "8px",
  "--gap-m": "12px",
  "--gap-l": "20px",
  "--gap-xl": "32px",
  "--radius-s": "8px",
  "--radius-m": "14px",
  "--radius-l": "22px",
  "--radius-round": "999px",
};

/** CSS declarations for one mode, ready to drop inside a selector block. */
export function modeDeclarations(mode: ThemeModeId): string {
  const { colorScheme, colors } = PALETTES[mode];
  const lines = [`color-scheme: ${colorScheme};`];
  for (const token of COLOR_TOKENS) lines.push(`--${token}: ${colors[token]};`);
  // Tactical reads as a terminal: UI text in the mono face.
  if (mode === "tactical") lines.push("--font-ui: var(--font-mono);");
  return lines.join("\n");
}

/** Declarations for the mode-independent tokens plus the default accent, so SSR paints before active-theme runs. */
export function sharedDeclarations(): string {
  const vars = { ...SHARED_TOKENS, ...accentVars(DEFAULT_ACCENT) };
  return Object.entries(vars)
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n");
}
