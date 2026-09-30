import { get } from "@calvinjs/active-state";

import { LAYERS, SELECTION, TIME, VIEW, type LayerId } from "./state";

/**
 * The HUD snapshot the browser posts as `view_state` for `view_screen` and `spawn_thinking`.
 * Shaped to cover the agent's view input (bbox, time, layers, selection).
 */
export type HudState = {
  camera: { lat: number; lon: number; altitudeM: number; place: string | null };
  bbox: { west: number; south: number; east: number; north: number };
  time: { at: string; live: boolean; playing: boolean; speed: number; from: string | null; to: string | null };
  layers: LayerId[];
  species: Partial<Record<LayerId, string>>;
  selection: string | null;
  drawerOpen: boolean;
};

/** Nadir view with a ~60° field of view: half the ground span is about altitude × tan(30°). */
const HALF_SPAN_PER_METER = Math.tan(Math.PI / 6);
const METERS_PER_DEGREE_LAT = 111_320;

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

export function bboxAround(lat: number, lon: number, altitudeM: number): HudState["bbox"] {
  const halfM = Math.max(500, altitudeM * HALF_SPAN_PER_METER);
  const dLat = halfM / METERS_PER_DEGREE_LAT;
  const dLon = Math.min(180, dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return {
    west: round4(Math.max(-180, lon - dLon)),
    south: round4(Math.max(-90, lat - dLat)),
    east: round4(Math.min(180, lon + dLon)),
    north: round4(Math.min(90, lat + dLat)),
  };
}

export function readHudState(now = Date.now()): HudState {
  const view = { ...VIEW.defaults, ...get<typeof VIEW.defaults>(VIEW) };
  const time = { ...TIME.defaults, ...get<typeof TIME.defaults>(TIME) };
  const layers = { ...LAYERS.defaults, ...get<typeof LAYERS.defaults>(LAYERS) };
  const selection = { ...SELECTION.defaults, ...get<typeof SELECTION.defaults>(SELECTION) };
  return {
    camera: { lat: view.lat, lon: view.lon, altitudeM: view.altitudeM, place: view.place },
    bbox: bboxAround(view.lat, view.lon, view.altitudeM),
    time: {
      at: time.at ?? new Date(now).toISOString(),
      live: time.at === null,
      playing: time.playing,
      speed: time.speed,
      from: time.from,
      to: time.to,
    },
    layers: (Object.keys(layers.visible) as LayerId[]).filter((id) => layers.visible[id]),
    species: layers.species,
    selection: selection.evidenceId,
    drawerOpen: selection.drawerOpen,
  };
}
