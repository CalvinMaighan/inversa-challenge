import { key, set } from "@calvinjs/active-state";

import { DEFAULT_APP_ID, getApp, LAYER_IDS, layerDefaultOn, speciesIds, type AppConfig, type LayerId } from "shared/apps";
import { SIGHTING_WINDOW_HOURS, SIGHTING_WINDOW_OPTIONS, type SightingWindowHours } from "shared/frames";

import { activeApp } from "./app";

export type { LayerId };
/** The focus species key of the active app (its config `taxa`, C-A3). */
export type SpeciesId = string;

/** Species filter applied to sightings and hotspots: the app's species key, on unless `false`. */
export type SpeciesFilter = Record<string, boolean>;

export type LayersState = {
  /** Visibility per globe layer. A layer the app does not list stays off. */
  visible: Record<LayerId, boolean>;
  species: SpeciesFilter;
  /** The trailing sightings window the globe draws and the chip counts, hours: the app's default window. */
  sightingHours: SightingWindowHours;
};

/**
 * LAYERS for a freshly selected app: its layers, its species, its default window. Which layers start on is the
 * config's `layers[].defaultOn`: sightings first in a species app (T41; stations, alerts, hotspots and the
 * temperature rasters start off, a tap away under "More data (for experts)"), everything listed in a conditions
 * app (carp). A layer the app does not list stays off.
 */
export function layersFor(app: AppConfig): LayersState {
  const window = app.windows.defaultHours;
  return {
    visible: Object.fromEntries(LAYER_IDS.map((id) => [id, layerDefaultOn(app, id)])) as Record<LayerId, boolean>,
    species: Object.fromEntries(speciesIds(app).map((id) => [id, true])),
    sightingHours: isWindowHours(window) ? window : SIGHTING_WINDOW_HOURS,
  };
}

export const LAYERS = key("LAYERS", layersFor(getApp(DEFAULT_APP_ID)));

export function setLayerVisible(layer: LayerId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, visible: { ...prev.visible, [layer]: visible } }));
}

export function setSpeciesVisible(species: SpeciesId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...prev.species, [species]: visible } }));
}

/** Species keys shown, in config order (a missing key reads as shown). */
export function shownSpecies(filter: Readonly<Record<string, unknown>> | undefined, app: AppConfig = activeApp()): SpeciesId[] {
  return speciesIds(app).filter((id) => filter?.[id] !== false);
}

/** Whether the filter hides the app's species. */
export function isSpeciesFiltered(filter: Readonly<Record<string, unknown>> | undefined, app: AppConfig = activeApp()): boolean {
  return speciesIds(app).some((id) => filter?.[id] === false);
}

export function isWindowHours(hours: unknown): hours is SightingWindowHours {
  return (SIGHTING_WINDOW_OPTIONS as readonly number[]).includes(hours as number);
}

/** The window of a LAYERS value, with a missing or unknown value reading as the default. */
export function sightingHoursOf(layers: Partial<LayersState> | undefined): SightingWindowHours {
  const h = layers?.sightingHours;
  return isWindowHours(h) ? h : SIGHTING_WINDOW_HOURS;
}
