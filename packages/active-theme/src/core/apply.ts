import type { ThemeColorPalette, ThemeDefinition, ThemeMode } from "./types";

function root(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

/** Set light/dark on `:root` (`data-theme`). CSS vars cascade immediately. */
export function applyMode(
  _theme: ThemeDefinition,
  mode: ThemeMode,
): void {
  const el = root();
  if (!el) return;
  el.dataset.theme = mode;
}

/** Set accent color id + hue/chroma CSS vars on `:root`. */
export function applyColor<C extends string>(
  theme: ThemeDefinition<C>,
  colorId: C,
): void {
  const el = root();
  if (!el) return;
  const palette = theme.colors[colorId] as ThemeColorPalette | undefined;
  if (!palette) return;

  el.dataset.accent = colorId;
  el.style.setProperty("--hue", String(palette.hue));
  el.style.setProperty("--hue-accent", String(palette.hue - 3));
  const chroma = palette.chromaBase ?? 0.036;
  el.style.setProperty("--chroma-base", String(chroma));
  el.style.setProperty("--chroma-accent", String(chroma * 11.111));
}

export function applyTheme<C extends string>(
  theme: ThemeDefinition<C>,
  mode: ThemeMode,
  colorId: C,
): void {
  applyMode(theme, mode);
  applyColor(theme, colorId);
}

export function readModeFromDocument(): ThemeMode | undefined {
  const el = root();
  if (!el) return undefined;
  const mode = el.dataset.theme;
  return mode === "light" || mode === "dark" ? mode : undefined;
}

export function readColorFromDocument(): string | undefined {
  return root()?.dataset.accent;
}
