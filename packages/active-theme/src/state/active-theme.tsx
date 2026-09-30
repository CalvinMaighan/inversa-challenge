import { useActiveState } from "@calvinjs/active-state/react";
import {
  applyTheme,
  type ThemeDefinition,
  type ThemeMode,
} from "active-theme";
import { useLayoutEffect, type ReactNode } from "react";

export type ActiveThemeProps<C extends string = string> = {
  /** Theme catalog from `defineTheme({ …, persist: false })`. */
  init: ThemeDefinition<C>;
  /** active-state key for mode. Default `"THEME"`. */
  themeKey?: string;
  /** active-state key for accent. Default `"ACCENT_COLOR"`. */
  colorKey?: string;
  children?: ReactNode;
};

/**
 * Sync bus → `:root`. Mount under `<ActiveState init={state} />` after
 * `themeKeys()` are in that catalog.
 *
 * @example
 * <ActiveState init={state} ssr />
 * <ActiveTheme init={theme} />
 */
export function ActiveTheme<C extends string>({
  init: theme,
  themeKey = "THEME",
  colorKey = "ACCENT_COLOR",
  children = null,
}: ActiveThemeProps<C>): ReactNode {
  const [mode] = useActiveState<ThemeMode>(themeKey);
  const [color] = useActiveState<C>(colorKey);

  useLayoutEffect(() => {
    const nextMode = mode ?? theme.defaultMode;
    const nextColor =
      color && color in theme.colors ? color : theme.defaultColor;
    applyTheme(theme, nextMode, nextColor);
  }, [theme, mode, color]);

  return children;
}
