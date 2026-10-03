"use client";

import { useSyncExternalStore } from "react";

import type { CarpSighting } from "client/carp/sighting-type";

/**
 * Asian carp sightings on the carp map (silver, bighead, grass and black carp in the Mississippi River Basin), from
 * `/v1/carp/sightings` (iNaturalist, GBIF and USGS NAS, stored in the carp SQLite database by the API). One shared store: the markers draw it, the Carp
 * chip counts it and toggles it. The timeline picks a start and an end date (the last `YEARS` years at most, what the server
 * returns) and a cursor within them that it moves (and plays): the map shows the sightings dated from the start up to the cursor,
 * each a dot in its species' colour.
 */
export type { CarpSighting };

export const FISH_COLOR = "#e8a33d";
export const YEARS = 2;
const MAX = 5000;

/** One colour per species, as the legend and the map dots use them. */
export const SPECIES_COLORS: readonly { name: string; color: string }[] = [
  { name: "Silver carp", color: "#5ab0ff" },
  { name: "Bighead carp", color: "#c58bff" },
  { name: "Grass carp", color: "#5fd068" },
  { name: "Black carp", color: "#ff9a3d" },
];
export const speciesColor = (species: string): string => SPECIES_COLORS.find((s) => s.name === species)?.color ?? FISH_COLOR;

type FishState = {
  visible: boolean;
  status: "idle" | "loading" | "ready" | "error";
  /** Every record the server returned. */
  all: CarpSighting[];
  /** The records between the start and end dates: what the timeline counts. */
  windowed: CarpSighting[];
  /** The window up to the time cursor: what the map draws and the chip counts. */
  shown: CarpSighting[];
  /** The timeline's start and end, ms (the last `YEARS` years to now at first). */
  startMs: number;
  endMs: number;
  /** The time cursor, ms, within start and end (the end at first). */
  atMs: number;
  playing: boolean;
  /** Days of sightings time per second of play, per speed step. */
  speed: Speed;
  sources: Record<string, number | string>;
  /** The sighting whose panel is open, or null. */
  selectedId: string | null;
  /** Species switched off in the top row (by name): not drawn, not counted in `shown`. */
  hidden: string[];
};

export const SPEEDS = [1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];
const DAYS_PER_SECOND = 15;
const DAY_MS = 86_400_000;

/** The earliest the timeline may start, ms: `YEARS` years back (the span the server returns). */
export const windowStartMs = (nowMs: number) => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear() - YEARS, d.getUTCMonth(), d.getUTCDate());
};

const now0 = Date.now();
let state: FishState = {
  visible: true,
  status: "idle",
  all: [],
  windowed: [],
  shown: [],
  startMs: windowStartMs(now0),
  endMs: now0,
  atMs: now0,
  playing: false,
  speed: 1,
  sources: {},
  selectedId: null,
  hidden: [],
};
const listeners = new Set<() => void>();
const set = (next: Partial<FishState>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

/** The records dated up to `atMs`, without the species switched off. */
const upTo = (list: readonly CarpSighting[], atMs: number, hidden: readonly string[] = state.hidden) =>
  list.filter((s) => s.date !== null && Date.parse(s.date) <= atMs && !hidden.includes(s.species));

/** Show or hide one species (by name) on the map. */
export function toggleSpecies(name: string): void {
  const hidden = state.hidden.includes(name) ? state.hidden.filter((n) => n !== name) : [...state.hidden, name];
  set({ hidden, shown: upTo(state.windowed, state.atMs, hidden) });
}

/** Show only (or show or hide) one species by name, as the legend chips do; `only` hides the others. */
export function filterSpecies(name: string, visible: boolean, only = false): void {
  const all = SPECIES_COLORS.map((s) => s.name);
  const hidden = only ? all.filter((n) => n !== name) : visible ? state.hidden.filter((n) => n !== name) : [...new Set([...state.hidden, name])];
  set({ hidden, shown: upTo(state.windowed, state.atMs, hidden) });
}

/** One loaded sighting by id, or undefined. */
export const fishById = (id: string): CarpSighting | undefined => state.all.find((s) => s.id === id);

/** The records dated within `[startMs, endMs]` (the end day included), newest first, capped. */
export function rangeFish(all: readonly CarpSighting[], startMs: number, endMs: number): CarpSighting[] {
  return all.filter((s) => s.date !== null && Date.parse(s.date) >= startMs && Date.parse(s.date) < endMs + DAY_MS).slice(0, MAX);
}

/** Move the time cursor: the map shows the sightings dated up to `atMs`. */
export function setFishAt(atMs: number): void {
  set({ atMs, shown: upTo(state.windowed, atMs) });
}

/** Set the timeline's start and end dates (ms): kept within the last `YEARS` years, the start never after the end. The cursor goes to the end. */
export function setFishRange(startMs: number, endMs: number, nowMs = Date.now()): void {
  const floor = windowStartMs(nowMs);
  const end = Math.min(nowMs, Math.max(floor, endMs));
  const start = Math.min(end, Math.max(floor, startMs));
  const windowed = rangeFish(state.all, start, end);
  stopPlay();
  set({ startMs: start, endMs: end, atMs: end, windowed, shown: upTo(windowed, end), playing: false });
}

export function setFishSpeed(speed: Speed): void {
  set({ speed });
}

let timer: ReturnType<typeof setInterval> | null = null;
function stopPlay() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Play from the cursor (from the start date when it is at the end) at the chosen speed; pause when playing. */
export function toggleFishPlay(): void {
  if (state.playing) {
    stopPlay();
    set({ playing: false });
    return;
  }
  const { startMs, endMs } = state;
  if (state.atMs >= endMs - DAY_MS) setFishAt(startMs);
  set({ playing: true });
  timer = setInterval(() => {
    const next = state.atMs + state.speed * DAYS_PER_SECOND * 0.1 * DAY_MS;
    if (next >= endMs) {
      setFishAt(endMs);
      stopPlay();
      set({ playing: false });
    } else setFishAt(next);
  }, 100);
}

/** Open the panel for a sighting (null closes it). */
export function selectFish(selectedId: string | null): void {
  set({ selectedId });
}

export function setFishVisible(visible: boolean): void {
  set({ visible });
}

/** Fetch once per page load. */
export function loadFish(): void {
  if (state.status !== "idle") return;
  set({ status: "loading" });
  fetch("/v1/carp/sightings")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((body: { sightings: CarpSighting[]; sources: Record<string, number | string> }) => {
      const windowed = rangeFish(body.sightings, state.startMs, state.endMs);
      set({ status: "ready", all: body.sightings, windowed, shown: upTo(windowed, state.atMs), sources: body.sources });
    })
    .catch(() => set({ status: "error" }));
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => state;

export function useFish(): FishState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
