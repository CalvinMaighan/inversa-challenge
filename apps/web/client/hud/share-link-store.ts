/**
 * Share link ↔ store. Reads the app and the keys a link carries (VIEW, TIME, LAYERS, SELECTION, and the look:
 * LOOK, SCOPE_ON, SCOPE_SHAPE, SCOPE_SIZE, SCOPE_FEATHER) into a `ShareState`, and applies a decoded link back onto them, flying the globe to the restored camera once it is up.
 * The link's fields are the active app's: `ShareLinkSync` skips a link of another app (the URL's `?app=` wins).
 */
import { get, set } from "@calvinjs/active-state";

import { hasLayer, speciesIds } from "shared/apps";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { onGlobeReady } from "client/globe/api";
import { activeApp, activeAppId } from "client/state/app";
import { applyCarpView, carpState, type CarpState } from "client/state/carp";
import { LAYERS, shownSpecies, type LayersState } from "client/state/layers";
import { featherOf, LOOK, lookOf, SCOPE_FEATHER, SCOPE_ON, SCOPE_SHAPE, SCOPE_SIZE, scopeOnOf, shapeOf, sizeOf } from "client/state/look";
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
    evidenceId: selection.evidenceId,
    ...(activeApp().kind === "conditions" ? carpShareFields(carpState()) : {}),
    look: lookOf(get(LOOK)),
    scope: scopeOnOf(get(SCOPE_ON)),
    shape: shapeOf(get(SCOPE_SHAPE)),
    size: sizeOf(get(SCOPE_SIZE)),
    feather: featherOf(get(SCOPE_FEATHER)),
  };
}

function carpShareFields(carp: CarpState): Pick<ShareState, "site" | "asOf"> {
  return { site: carp.site, asOf: carp.asOf !== undefined ? new Date(carp.asOf).toISOString() : undefined };
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
  if (state.layers || state.species) {
    // Only layers the app has can be turned on, whatever the link says.
    const visibleIds = state.layers ? new Set(state.layers.filter((id) => hasLayer(app, id))) : null;
    const shown = state.species ? new Set(state.species) : null;
    set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
      // A link's species list replaces the species keys.
      const species: LayersState["species"] = { ...prev.species };
      if (shown) for (const id of speciesIds(app)) species[id] = shown.has(id);
      return {
        ...prev,
        visible: visibleIds ? (Object.fromEntries(LAYER_IDS.map((id) => [id, visibleIds.has(id)])) as LayersState["visible"]) : prev.visible,
        species,
      };
    });
  }
  if (state.evidenceId) {
    const evidenceId = state.evidenceId;
    set<HudSelection>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId, drawerOpen: true }));
  }
  // Carp: a link without `asof` is live; a site the app does not have is ignored.
  if (app.kind === "conditions" && (state.site || state.asOf)) applyCarpView({ site: state.site, asOf: state.asOf ?? null, replay: false });
  if (state.look !== undefined) set(LOOK, lookOf(state.look));
  if (state.scope !== undefined) set(SCOPE_ON, scopeOnOf(state.scope));
  if (state.shape !== undefined) set(SCOPE_SHAPE, shapeOf(state.shape));
  if (state.size !== undefined) set(SCOPE_SIZE, sizeOf(state.size));
  if (state.feather !== undefined) set(SCOPE_FEATHER, featherOf(state.feather));
  return cancelFly;
}
