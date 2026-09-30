/**
 * active-state adapter — mode/color live on the bus; `<ActiveTheme />` paints `:root`.
 *
 * @example
 * import { defineTheme } from "active-theme";
 * import { ActiveTheme, themeKeys } from "active-theme/state";
 * import { catalog } from "active-state";
 * import { ActiveState } from "active-state/react";
 *
 * export const theme = defineTheme({ defaultColor: "orange", colors: { … }, persist: false });
 * export const { THEME, ACCENT_COLOR } = themeKeys({ defaultColor: "orange" });
 * export const state = catalog(THEME, ACCENT_COLOR);
 *
 * <ActiveState init={state} ssr />
 * <ActiveTheme init={theme} />
 */
export { ActiveTheme, type ActiveThemeProps } from "./active-theme";
export { syncThemeFromState, themeKeys } from "./adapter";
