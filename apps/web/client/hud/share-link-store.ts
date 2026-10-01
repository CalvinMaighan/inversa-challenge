/**
 * Share link ↔ store. Reads the app and the four keys a link carries (VIEW, TIME, LAYERS, SELECTION) into a
 * `ShareState`, and applies a decoded link back onto them, flying the globe to the restored camera once it is up.
 * The link's fields are the active app's: `ShareLinkSync` skips a link of another app (the URL's `?app=` wins).
 */
import { get, set } from "@calvinjs/active-state";

import { hasLayer } from "shared/apps";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { onGlobeReady } from "client/globe/api";
import { activeApp, activeAppId } from "client/state/app";
import { LAYERS, shownSpecies, sightingHoursOf, speciesFilterIds, taxonKey, taxonOverrides, TAXON_KEY, type LayersState } from "client/state/layers";
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
    app: activeAppId(),
    camera: { lat: view.lat, lon: view.lon, altitudeM: view.altitudeM, heading: view.heading, pitch: view.pitch },
    // Live links carry no time: opening one later lands on the live edge of that moment, not in replay.
    at: isLive(time, Date.now()) && !time.playing ? undefined : (time.at ?? time.to),
    layers: LAYER_IDS.filter((id) => layers.visible[id]),
    species: shownSpecies(layers.species),
    taxa: taxonOverrides(layers.species),
    hours: sightingHoursOf(layers),
    evidenceId: selection.evidenceId,
  };
}

/** Apply a decoded link. Returns an unsubscribe for the pending globe fly, a no-op once it has flown. */
export function applyShareState(state: ShareState): () => void {
  const app = activeApp();
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
  if (state.layers || state.species || state.taxa || state.hours) {
    // Only layers the app has can be turned on, whatever the link says.
    const visibleIds = state.layers ? new Set(state.layers.filter((id) => hasLayer(app, id))) : null;
    const speciesIds = state.species ? new Set(state.species) : null;
    set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
      // Layer pins travel along; a link's species list replaces the keys and the taxon overrides.
      const species: LayersState["species"] = { ...prev.species };
      if (speciesIds || state.taxa) for (const k of Object.keys(species)) if (TAXON_KEY.test(k)) delete species[k];
      if (speciesIds) for (const id of speciesFilterIds(app)) species[id] = speciesIds.has(id);
      for (const [id, shown] of state.taxa ?? []) species[taxonKey(id)] = shown;
      return {
        ...prev,
        visible: visibleIds ? (Object.fromEntries(LAYER_IDS.map((id) => [id, visibleIds.has(id)])) as LayersState["visible"]) : prev.visible,
        species,
        sightingHours: state.hours ?? prev.sightingHours,
      };
    });
  }
  if (state.evidenceId) {
    const evidenceId = state.evidenceId;
    set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId, drawerOpen: true }));
  }
  return cancelFly;
}
