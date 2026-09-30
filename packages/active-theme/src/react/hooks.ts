import { useCallback, useSyncExternalStore } from "react";
import {
  getActiveTheme,
  readColorFromDocument,
  readModeFromDocument,
  readStoredColor,
  readStoredMode,
  setColor,
  setMode,
  type ThemeMode,
} from "active-theme";

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: Listener): () => void {
  listeners.add(onChange);
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const obs = new MutationObserver(() => onChange());
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent", "style"],
    });
    return () => {
      listeners.delete(onChange);
      obs.disconnect();
    };
  }
  return () => {
    listeners.delete(onChange);
  };
}

function currentMode(): ThemeMode {
  const theme = getActiveTheme();
  return (
    readModeFromDocument() ??
    (theme ? readStoredMode(theme) : undefined) ??
    theme?.defaultMode ??
    "dark"
  );
}

function currentColor(): string {
  const theme = getActiveTheme();
  return (
    readColorFromDocument() ??
    (theme ? readStoredColor(theme) : undefined) ??
    theme?.defaultColor ??
    ""
  );
}

export type UseThemeResult = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  color: string;
  setColor: (colorId: string) => void;
};

/** Reads mode/color from `:root` (+ storage defaults). */
export function useTheme(): UseThemeResult {
  const mode = useSyncExternalStore(subscribe, currentMode, () => "dark" as ThemeMode);
  const color = useSyncExternalStore(subscribe, currentColor, () => "");

  const setModeValue = useCallback((next: ThemeMode) => {
    setMode(next);
    emit();
  }, []);

  const setColorValue = useCallback((next: string) => {
    setColor(next);
    emit();
  }, []);

  return { mode, setMode: setModeValue, color, setColor: setColorValue };
}

export function useThemeColor(): [string, (colorId: string) => void] {
  const { color, setColor: set } = useTheme();
  return [color, set];
}
