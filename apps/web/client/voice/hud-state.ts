import { get } from "@calvinjs/active-state";

import { LAYERS, SELECTION, TIME, VIEW } from "client/state";
import type { LayerId, LayersState, SpeciesId } from "client/state/layers";
import type { SelectionState } from "client/state/selection";
import type { TimeState } from "client/state/time";
import type { ViewState } from "client/state/view";
import type { BBox } from "shared/agent/events";

/**
 * The HUD snapshot the browser posts as `view_state` for `view_screen` and `spawn_thinking`.
 * Covers the agent's view input (bbox, time, layers, selection) plus the camera.
 */
export type HudState = {
  camera: { lat: number; lon: number; altitudeM: number; place: string | null };
  bbox: BBox;
  time: { at: string; live: boolean; playing: boolean; speed: number; from: string; to: string };
  layers: LayerId[];
  species: SpeciesId[];
  selection: string | null;
  drawerOpen: boolean;
};

/** Nadir view with a ~60° field of view: half the ground span is about altitude × tan(30°). */
const HALF_SPAN_PER_METER = Math.tan(Math.PI / 6);
const METERS_PER_DEGREE_LAT = 111_320;

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** Approximate visible extent for a camera looking straight down. */
export function bboxAround(lat: number, lon: number, altitudeM: number): BBox {
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

export function readHudState(): HudState {
  const view = { ...VIEW.defaults, ...get<ViewState>(VIEW) };
  const time = { ...TIME.defaults, ...get<TimeState>(TIME) };
  const layers = { ...LAYERS.defaults, ...get<LayersState>(LAYERS) };
  const selection = { ...SELECTION.defaults, ...get<SelectionState>(SELECTION) };
  return {
    camera: { lat: view.lat, lon: view.lon, altitudeM: view.altitudeM, place: view.place },
    bbox: view.bbox,
    time: { ...time, live: time.at === time.to && !time.playing },
    layers: (Object.keys(layers.visible) as LayerId[]).filter((id) => layers.visible[id]),
    species: (Object.keys(layers.species) as SpeciesId[]).filter((id) => layers.species[id]),
    selection: selection.evidenceId,
    drawerOpen: selection.drawerOpen,
  };
}
