import { defineTheme, type ThemeMode } from "active-theme";

import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  THEME_MODES,
  type AccentId,
  type ThemeModeId,
} from "./palette";

/**
 * active-theme definition. `persist: false` because the active-state bus owns storage: THEME and ACCENT_COLOR
 * (client/state/theme.ts) persist under the `inversa:` prefix and `<ActiveTheme />` paints `:root` from them.
 *
 * active-theme types modes as "light" | "dark"; its runtime writes any mode string to `data-theme`, so the
 * tactical mode goes through a cast here and nowhere else.
 */
export const theme = defineTheme<AccentId>({
  modes: THEME_MODES as readonly string[] as readonly ThemeMode[],
  defaultMode: DEFAULT_MODE as ThemeMode,
  defaultColor: DEFAULT_ACCENT,
  colors: ACCENTS,
  persist: false,
});

/** Next mode in light → dark → tactical order, for a single cycling control. */
export function nextMode(mode: ThemeModeId): ThemeModeId {
  return THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
}

/**
 * Emotion theme. Values are CSS variables, so one object serves every mode and a mode switch repaints
 * without re-rendering React.
 */
export const emotionTheme = {
  color: {
    bg: "var(--bg)",
    surface: "var(--surface)",
    surface2: "var(--surface-2)",
    text: "var(--text)",
    muted: "var(--muted)",
    border: "var(--border)",
    accent: "var(--accent)",
    accentHover: "var(--accent-hover)",
    accentFg: "var(--accent-fg)",
    danger: "var(--danger)",
    warn: "var(--warn)",
    ok: "var(--ok)",
    hudLine: "var(--hud-line)",
    hudGlow: "var(--hud-glow)",
    shadow: "var(--shadow)",
  },
  font: {
    sans: "var(--font-sans)",
    mono: "var(--font-mono)",
    ui: "var(--font-ui)",
  },
} as const;

export type AppTheme = typeof emotionTheme;

declare module "@emotion/react" {
  interface Theme {
    color: AppTheme["color"];
    font: AppTheme["font"];
  }
}
