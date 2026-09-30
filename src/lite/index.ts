/**
 * Apply-only surface — no localStorage, no cross-tab sync.
 * Use when you own persistence (or don't need it).
 */
export {
  applyColor,
  applyMode,
  applyTheme,
  readColorFromDocument,
  readModeFromDocument,
  type ThemeColorPalette,
  type ThemeDefinition,
  type ThemeMode,
} from "active-theme";

export { defineTheme } from "./define-lite";
