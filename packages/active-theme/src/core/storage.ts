import type { ThemeDefinition, ThemeMode } from "./types";

const MODE_SUFFIX = "mode";
const COLOR_SUFFIX = "color";

function canUseStorage(): boolean {
  return typeof globalThis.localStorage !== "undefined";
}

export function modeStorageKey(theme: ThemeDefinition): string {
  return `${theme.storagePrefix}${MODE_SUFFIX}`;
}

export function colorStorageKey(theme: ThemeDefinition): string {
  return `${theme.storagePrefix}${COLOR_SUFFIX}`;
}

export function readStoredMode(theme: ThemeDefinition): ThemeMode | undefined {
  if (!canUseStorage() || !theme.persist) return undefined;
  try {
    const raw = globalThis.localStorage.getItem(modeStorageKey(theme));
    return raw === "light" || raw === "dark" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function readStoredColor<C extends string>(
  theme: ThemeDefinition<C>,
): C | undefined {
  if (!canUseStorage() || !theme.persist) return undefined;
  try {
    const raw = globalThis.localStorage.getItem(colorStorageKey(theme));
    if (raw != null && raw in theme.colors) return raw as C;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredMode(theme: ThemeDefinition, mode: ThemeMode): void {
  if (!canUseStorage() || !theme.persist) return;
  try {
    globalThis.localStorage.setItem(modeStorageKey(theme), mode);
  } catch {
    /* quota / private mode */
  }
}

export function writeStoredColor<C extends string>(
  theme: ThemeDefinition<C>,
  colorId: C,
): void {
  if (!canUseStorage() || !theme.persist) return;
  try {
    globalThis.localStorage.setItem(colorStorageKey(theme), colorId);
  } catch {
    /* quota / private mode */
  }
}
