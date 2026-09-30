import type { DefineThemeInput, ThemeDefinition } from "active-theme";

/** Same shape as `defineTheme`, but forces persist/shared off. */
export function defineTheme<C extends string>(
  input: DefineThemeInput<C>,
): ThemeDefinition<C> {
  return {
    modes: input.modes ?? (["light", "dark"] as const),
    defaultMode: input.defaultMode ?? "dark",
    defaultColor: input.defaultColor,
    colors: input.colors,
    persist: false,
    shared: false,
    storagePrefix: input.storagePrefix ?? "active-theme:",
  };
}
