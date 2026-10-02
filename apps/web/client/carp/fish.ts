"use client";

import { useSyncExternalStore } from "react";

import type { CarpSighting } from "client/carp/sighting-type";

/**
 * Asian carp sightings on the carp map (silver, bighead, grass and black carp in Louisiana), from `/api/carp/sightings`
 * (iNaturalist, GBIF and USGS NAS merged on the server). One shared store: the markers draw it, the Carp chip counts it and
 * toggles it. Only recent records show (the last `YEARS` years, at most `MAX` markers, newest first): older museum and survey
 * records stay out of the way.
 */
export type { CarpSighting };

export const FISH_COLOR = "#e8a33d";
export const YEARS = 5;
const MAX = 300;

type FishState = {
  visible: boolean;
  status: "idle" | "loading" | "ready" | "error";
  /** Every record the server returned. */
  all: CarpSighting[];
  /** The recent window (`recentFish`): what the timeline counts. */
  windowed: CarpSighting[];
  /** The window from the timeline's cursor on: what the map draws and the chip counts. */
  shown: CarpSighting[];
  /** The timeline's cursor: only sightings dated on or after it show (null: the whole window). */
  sinceMs: number | null;
  sources: Record<string, number | string>;
};

let state: FishState = { visible: true, status: "idle", all: [], windowed: [], shown: [], sinceMs: null, sources: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<FishState>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

/** Move the timeline's cursor: the map shows sightings dated on or after `sinceMs` (null: all of the window). */
export function setFishSince(sinceMs: number | null): void {
  set({ sinceMs, shown: sinceMs === null ? state.windowed : state.windowed.filter((s) => s.date !== null && Date.parse(s.date) >= sinceMs) });
}

export function setFishVisible(visible: boolean): void {
  set({ visible });
}

/** Fetch once per page load. */
export function loadFish(): void {
  if (state.status !== "idle") return;
  set({ status: "loading" });
  fetch("/api/carp/sightings")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((body: { sightings: CarpSighting[]; sources: Record<string, number | string> }) => set({ status: "ready", all: body.sightings, windowed: recentFish(body.sightings, Date.now()), shown: recentFish(body.sightings, Date.now()), sources: body.sources }))
    .catch(() => set({ status: "error" }));
}

/** The records the map draws: dated within the window, newest first, capped. */
export function recentFish(all: readonly CarpSighting[], nowMs: number): CarpSighting[] {
  const from = new Date(nowMs).getFullYear() - YEARS;
  return all.filter((s) => s.date !== null && Number(s.date.slice(0, 4)) >= from).slice(0, MAX);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => state;

export function useFish(): FishState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
