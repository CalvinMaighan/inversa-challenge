import { applyTheme } from "./apply";
import {
  readStoredColor,
  readStoredMode,
  writeStoredColor,
  writeStoredMode,
} from "./storage";
import type { DefineThemeInput, ThemeDefinition, ThemeMode } from "./types";

const DEFAULT_PREFIX = "active-theme:";

let active: ThemeDefinition<string> | null = null;
let stopShared: (() => void) | null = null;

function startSharedSync(theme: ThemeDefinition<string>): void {
  stopShared?.();
  stopShared = null;
  if (!theme.shared || typeof globalThis.window === "undefined") return;

  const onStorage = (event: Event) => {
    const e = event as StorageEvent;
    if (!e.key || e.newValue == null) return;
    if (e.key === `${theme.storagePrefix}mode`) {
      if (e.newValue === "light" || e.newValue === "dark") {
        applyTheme(theme, e.newValue, (readStoredColor(theme) ?? theme.defaultColor) as string);
      }
      return;
    }
    if (e.key === `${theme.storagePrefix}color` && e.newValue in theme.colors) {
      const mode = readStoredMode(theme) ?? theme.defaultMode;
      applyTheme(theme, mode, e.newValue);
    }
  };

  globalThis.window.addEventListener("storage", onStorage);
  stopShared = () => globalThis.window.removeEventListener("storage", onStorage);
}

/**
 * Define modes + color palettes. Main entry persists/shared by default.
 * Use `active-theme/lite` when you only want `applyMode` / `applyColor`.
 */
export function defineTheme<C extends string>(
  input: DefineThemeInput<C>,
): ThemeDefinition<C> {
  const persist = input.persist !== false;
  const theme: ThemeDefinition<C> = {
    modes: input.modes ?? (["light", "dark"] as const),
    defaultMode: input.defaultMode ?? "dark",
    defaultColor: input.defaultColor,
    colors: input.colors,
    persist,
    shared: input.shared ?? persist,
    storagePrefix: input.storagePrefix ?? DEFAULT_PREFIX,
  };

  active = theme as ThemeDefinition<string>;
  startSharedSync(active);
  return theme;
}

export function getActiveTheme(): ThemeDefinition<string> | null {
  return active;
}

/** Apply mode to `:root` and persist when enabled. */
export function setMode(mode: ThemeMode, theme = active): void {
  if (!theme) {
    throw new Error("[active-theme] Call defineTheme() before setMode().");
  }
  const color = (readStoredColor(theme) ?? theme.defaultColor) as string;
  applyTheme(theme, mode, color);
  writeStoredMode(theme, mode);
}

/** Apply color to `:root` and persist when enabled. */
export function setColor<C extends string>(
  colorId: C,
  theme: ThemeDefinition<C> | null = active as ThemeDefinition<C> | null,
): void {
  if (!theme) {
    throw new Error("[active-theme] Call defineTheme() before setColor().");
  }
  if (!(colorId in theme.colors)) {
    throw new Error(`[active-theme] Unknown color "${String(colorId)}".`);
  }
  const mode = readStoredMode(theme) ?? theme.defaultMode;
  applyTheme(theme, mode, colorId);
  writeStoredColor(theme, colorId);
}

/**
 * Boot from storage (or defaults) onto `:root`.
 * Call once after `defineTheme` (e.g. in root layout).
 */
export function hydrateTheme(theme: ThemeDefinition = active!): void {
  if (!theme) {
    throw new Error("[active-theme] Call defineTheme() before hydrateTheme().");
  }
  const mode = readStoredMode(theme) ?? theme.defaultMode;
  const color = (readStoredColor(theme) ?? theme.defaultColor) as string;
  applyTheme(theme, mode, color);
}

export function resetThemeRuntime(): void {
  stopShared?.();
  stopShared = null;
  active = null;
}
