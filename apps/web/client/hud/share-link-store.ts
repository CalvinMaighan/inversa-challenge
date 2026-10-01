/**
 * Share link ↔ store. Reads the four keys a link carries (VIEW, TIME, LAYERS, SELECTION) into a `ShareState`,
 * and applies a decoded link back onto them, flying the globe to the restored camera once it is up.
 */
import { get, set } from "@calvinjs/active-state";

import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import { onGlobeReady } from "client/globe/api";
import { LAYERS, type LayersState } from "client/state/layers";
import { SELECTION } from "client/state/selection";
import { retime, TIME, type TimeState } from "client/state/time";
import { VIEW, type ViewState } from "client/state/view";

import type { HudSelection } from "./selection";
import { isLive } from "./topbar/clock";
import type { ShareState } from "./share-link";

export function readShareState(): ShareState {
  const view = get<ViewState>(VIEW) ?? VIEW.defaults;
  const time = get<TimeState>(TIME) ?? TIME.defaults;
  const layers = get<LayersState>(LAYERS) ?? LAYERS.defaults;
  const selection = get<HudSelection>(SELECTION) ?? SELECTION.defaults;
  return {
    camera: { lat: view.lat, lon: view.lon, altitudeM: view.altitudeM, heading: view.heading, pitch: view.pitch },
    // Live links carry no time: opening one later lands on the live edge of that moment, not in replay.
    at: isLive(time, Date.now()) && !time.playing ? undefined : (time.at ?? time.to),
    layers: LAYER_IDS.filter((id) => layers.visible[id]),
    species: SPECIES_IDS.filter((id) => layers.species[id]),
    evidenceId: selection.evidenceId,
  };
}

/** Apply a decoded link. Returns an unsubscribe for the pending globe fly, a no-op once it has flown. */
export function applyShareState(state: ShareState): () => void {
  let cancelFly = () => {};
  if (state.camera) {
    const camera = state.camera;
    set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...camera }));
    let flown = false;
    const off = onGlobeReady((api) => {
      if (flown) return;
      flown = true;
      api.flyTo({ ...camera, durationS: 0 });
    });
    if (flown) off();
    cancelFly = off;
  }
  if (state.at) {
    const atMs = Date.parse(state.at);
    // A link to a time outside the window brings its window along (the db worker fetches those frames).
    set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...retime(prev, atMs, Date.now()), playing: false }));
  }
  if (state.layers || state.species) {
    const visibleIds = state.layers ? new Set(state.layers) : null;
    const speciesIds = state.species ? new Set(state.species) : null;
    set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({
      visible: visibleIds
        ? (Object.fromEntries(LAYER_IDS.map((id) => [id, visibleIds.has(id)])) as LayersState["visible"])
        : prev.visible,
      species: speciesIds
        ? (Object.fromEntries(SPECIES_IDS.map((id) => [id, speciesIds.has(id)])) as Record<(typeof SPECIES_IDS)[number], boolean>)
        : prev.species,
    }));
  }
  if (state.evidenceId) {
    const evidenceId = state.evidenceId;
    set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId, drawerOpen: true }));
  }
  return cancelFly;
}
