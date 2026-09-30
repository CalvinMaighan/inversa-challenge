import { key } from "@calvinjs/active-state";
import {
  applyTheme,
  type ThemeDefinition,
  type ThemeMode,
} from "active-theme";

/** Register THEME + ACCENT_COLOR on the active-state catalog. */
export function themeKeys(options?: {
  defaultMode?: ThemeMode;
  defaultColor?: string;
  persist?: boolean;
  shared?: boolean;
}) {
  const persist = options?.persist !== false;
  const shared = options?.shared ?? persist;
  const THEME = key("THEME", options?.defaultMode ?? "dark", {
    persist,
    shared,
  });
  const ACCENT_COLOR = key("ACCENT_COLOR", options?.defaultColor ?? "orange", {
    persist,
    shared,
  });
  return { THEME, ACCENT_COLOR };
}

/** Push bus values onto `:root` (call from a small sync effect). */
export function syncThemeFromState<C extends string>(
  theme: ThemeDefinition<C>,
  mode: ThemeMode,
  colorId: C,
): void {
  applyTheme(theme, mode, colorId);
}
