/**
 * Lionfish HUD view state that no other surface writes: the area chip, the date basis, the window, the late
 * filter, the heat and field-window layers and the help panel. Sightings and survey priority visibility live in
 * LAYERS (`sightings`, `hotspots`) so the share link and the agent see them too; the selected priority cell
 * lives in SELECTION (`hotspot:<species>:<cell>:<ms>`).
 */
import { useSyncExternalStore } from "react";

import { DEFAULT_WINDOW_DAYS, type Basis, type WindowDays } from "./model";

export type HelpTopic = "temperature" | "anomaly" | "dhw" | "baa" | "waves" | "currents";

export type LionfishView = {
  area: string | null;
  basis: Basis;
  days: WindowDays;
  lateOnly: boolean;
  heat: boolean;
  field: boolean;
  /** Help panel open, on a topic (null: closed). */
  help: HelpTopic | "all" | null;
  /** Left panel on phones: closed until asked for. Null follows the viewport. */
  panelOpen: boolean | null;
};

export const VIEW_DEFAULTS: LionfishView = { area: null, basis: "observed", days: DEFAULT_WINDOW_DAYS, lateOnly: false, heat: true, field: false, help: null, panelOpen: null };

let state: LionfishView = VIEW_DEFAULTS;
const listeners = new Set<() => void>();

export function getView(): LionfishView {
  return state;
}

export function setView(patch: Partial<LionfishView> | ((prev: LionfishView) => Partial<LionfishView>)): void {
  const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  if (Object.keys(next).every((k) => next[k as keyof LionfishView] === state[k as keyof LionfishView])) return;
  state = next;
  for (const l of listeners) l();
}

/** Back to the defaults (an app switch remounts the HUD). */
export function resetView(initial: Partial<LionfishView> = {}): void {
  state = { ...VIEW_DEFAULTS, ...initial };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useView(): LionfishView {
  return useSyncExternalStore(subscribe, getView, () => VIEW_DEFAULTS);
}

// ---- the top-bar chip's numbers (the HUD computes them; the chip sits in the shared top row) ----

export type ChipSummary = { independent: number | null; days: number; basis: "observed" | "submitted" };
let summary: ChipSummary = { independent: null, days: DEFAULT_WINDOW_DAYS, basis: "observed" };
const summaryListeners = new Set<() => void>();

export function setSummary(next: ChipSummary): void {
  if (next.independent === summary.independent && next.days === summary.days && next.basis === summary.basis) return;
  summary = next;
  for (const l of summaryListeners) l();
}

export function useSummary(): ChipSummary {
  return useSyncExternalStore(
    (cb) => {
      summaryListeners.add(cb);
      return () => summaryListeners.delete(cb);
    },
    () => summary,
    () => summary,
  );
}

// ---- honesty banner: dismissed for this browser session only -----------------------------------

export const BANNER_KEY = "lionfish:honesty-dismissed";

export function bannerDismissed(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(BANNER_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissBanner(storage: Pick<Storage, "setItem"> | null | undefined): void {
  try {
    storage?.setItem(BANNER_KEY, "1");
  } catch {
    // Blocked storage: the banner simply comes back on the next load.
  }
}
