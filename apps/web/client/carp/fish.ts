"use client";

import { useSyncExternalStore } from "react";

import type { CarpSighting } from "client/carp/sighting-type";

/**
 * Asian carp sightings on the carp map (silver, bighead, grass and black carp in Louisiana), from `/api/carp/sightings`
 * (iNaturalist, GBIF and USGS NAS merged on the server). One shared store: the markers draw it, the Carp chip counts it and
 * toggles it. The map shows the last `YEARS` years up to a time cursor the timeline moves (and plays): a sighting is brightest at the
 * cursor and fades with its age down to `MIN_OPACITY` at a year old or more.
 */
export type { CarpSighting };

export const FISH_COLOR = "#e8a33d";
export const YEARS = 2;
const MAX = 300;

type FishState = {
  visible: boolean;
  status: "idle" | "loading" | "ready" | "error";
  /** Every record the server returned. */
  all: CarpSighting[];
  /** The recent window (`recentFish`): what the timeline counts. */
  windowed: CarpSighting[];
  /** The window up to the time cursor: what the map draws and the chip counts. */
  shown: CarpSighting[];
  /** The time cursor, ms (now at first). */
  atMs: number;
  playing: boolean;
  /** Days of sightings time per second of play, per speed step. */
  speed: Speed;
  sources: Record<string, number | string>;
};

export const SPEEDS = [1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];
const DAYS_PER_SECOND = 15;
const DAY_MS = 86_400_000;
/** The faintest a sighting gets, however old (a year or more). */
export const MIN_OPACITY = 0.15;
const FADE_MS = 365 * DAY_MS;

/** How visible a sighting dated `dateMs` is with the cursor at `atMs`: 1 at the cursor, down to MIN_OPACITY a year earlier; null after the cursor. */
export function fishOpacity(dateMs: number, atMs: number): number | null {
  const age = atMs - dateMs;
  if (age < 0) return null;
  return Math.max(MIN_OPACITY, 1 - (1 - MIN_OPACITY) * Math.min(1, age / FADE_MS));
}

/** The start of the window the timeline spans, ms. */
export const windowStartMs = (nowMs: number) => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear() - YEARS, d.getUTCMonth(), d.getUTCDate());
};

let state: FishState = { visible: true, status: "idle", all: [], windowed: [], shown: [], atMs: Date.now(), playing: false, speed: 1, sources: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<FishState>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

const upTo = (list: readonly CarpSighting[], atMs: number) => list.filter((s) => s.date !== null && Date.parse(s.date) <= atMs);

/** Move the time cursor: the map shows the sightings dated up to `atMs`. */
export function setFishAt(atMs: number): void {
  set({ atMs, shown: upTo(state.windowed, atMs) });
}

export function setFishSpeed(speed: Speed): void {
  set({ speed });
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Play from the cursor (from the start of the window when it is at the end) at the chosen speed; pause when playing. */
export function toggleFishPlay(nowMs = Date.now()): void {
  if (state.playing) {
    if (timer) clearInterval(timer);
    timer = null;
    set({ playing: false });
    return;
  }
  const start = windowStartMs(nowMs);
  if (state.atMs >= nowMs - DAY_MS) setFishAt(start);
  set({ playing: true });
  timer = setInterval(() => {
    const next = state.atMs + state.speed * DAYS_PER_SECOND * 0.1 * DAY_MS;
    if (next >= nowMs) {
      setFishAt(nowMs);
      if (timer) clearInterval(timer);
      timer = null;
      set({ playing: false });
    } else setFishAt(next);
  }, 100);
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
    .then((body: { sightings: CarpSighting[]; sources: Record<string, number | string> }) => {
      const windowed = recentFish(body.sightings, Date.now());
      set({ status: "ready", all: body.sightings, windowed, shown: upTo(windowed, state.atMs), sources: body.sources });
    })
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
