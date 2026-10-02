import type { ThemeDefinition, ThemeMode } from "active-theme";

/**
 * CSS text for Emotion / any injector — no @emotion import required here.
 * Wrap with `css` in the app: `css\`${modeStyles(theme, "dark")}\``.
 */
export function modeStyles(
  _theme: ThemeDefinition,
  mode: ThemeMode,
): string {
  return `
:root[data-theme="${mode}"] {
  color-scheme: ${mode};
}
`;
}

export function colorStyles<C extends string>(
  theme: ThemeDefinition<C>,
  colorId: C,
): string {
  const palette = theme.colors[colorId];
  if (!palette) return "";
  const chroma = palette.chromaBase ?? 0.036;
  return `
:root[data-accent="${colorId}"] {
  --hue: ${palette.hue};
  --hue-accent: ${palette.hue - 3};
  --chroma-base: ${chroma};
  --chroma-accent: ${chroma * 11.111};
}
`;
}
