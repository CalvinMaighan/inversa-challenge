import { key, set } from "@calvinjs/active-state";

import { DEFAULT_APP_ID, getApp, LAYER_IDS, layerDefaultOn, speciesIds, type AppConfig, type LayerId } from "shared/apps";
import { SIGHTING_WINDOW_HOURS, SIGHTING_WINDOW_OPTIONS, type SightingWindowHours } from "shared/frames";
import { CATEGORY_DEFAULT_ON, CATEGORY_IDS, type CategoryId } from "shared/species-categories";

import { activeApp } from "./app";

export type { LayerId };
/** A focus species key of the active app (its config `taxa`, C-A3). */
export type SpeciesId = string;
/** A focus species key or a category key. */
export type SpeciesFilterId = string;
export { CATEGORY_IDS };
export type { CategoryId };

/**
 * Species filter keys (T44): the app's focus species, then the categories every other sighting falls into
 * (snakes, lizards, turtles, ..., plants, other). Animal categories start on; insects, spiders, plants and the
 * rest start off.
 */
export function speciesFilterIds(app: AppConfig = activeApp()): SpeciesFilterId[] {
  return [...speciesIds(app), ...CATEGORY_IDS];
}

/** Filter key of one non-focus taxon (`taxa.id`): an override on top of its category. */
export const taxonKey = (taxonId: number | string): `t${string}` => `t${taxonId}`;
export const TAXON_KEY = /^t(\d+)$/;

/**
 * Species filter applied to sightings and hotspots. Focus and category keys read as their default when missing;
 * a `t<taxon id>` key overrides its taxon's category either way (a species hidden on its own, or "only this one"
 * with its category off). A layer id key holds a focus species id instead: it pins that layer to one species,
 * whatever the booleans say (`client/globe/species.ts` `enabledSpecies`); the legend's hotspot pin writes it.
 */
export type SpeciesFilter = Record<string, boolean | string>;

export type LayersState = {
  /** Visibility per globe layer. A layer the app does not list stays off. */
  visible: Record<LayerId, boolean>;
  species: SpeciesFilter;
  /** The trailing sightings window the globe draws and the bar counts, hours (T44). */
  sightingHours: SightingWindowHours;
};

/** Default of one filter key: focus species on, categories per CATEGORY_DEFAULT_ON. */
function keyDefault(id: string): boolean {
  return (CATEGORY_IDS as readonly string[]).includes(id) ? CATEGORY_DEFAULT_ON[id as CategoryId] : true;
}

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
    species: Object.fromEntries(speciesFilterIds(app).map((id) => [id, keyDefault(id)])),
    sightingHours: isWindowHours(window) ? window : SIGHTING_WINDOW_HOURS,
  };
}

export const LAYERS = key("LAYERS", layersFor(getApp(DEFAULT_APP_ID)));

export function setLayerVisible(layer: LayerId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, visible: { ...prev.visible, [layer]: visible } }));
}

export function setSpeciesVisible(species: SpeciesFilterId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...prev.species, [species]: visible } }));
}

/** Show or hide one non-focus taxon on its own (its chip or popover row). `null` drops the override: the taxon follows its category again. */
export function setTaxonVisible(taxonId: number | string, visible: boolean | null): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
    const next = { ...prev.species };
    if (visible === null) delete next[taxonKey(taxonId)];
    else next[taxonKey(taxonId)] = visible;
    return { ...prev, species: next };
  });
}

/** Every focus and category key off, every taxon override dropped; layer pins kept. */
function nothing(prev: SpeciesFilter): SpeciesFilter {
  const next = { ...prev };
  for (const k of Object.keys(next)) if (TAXON_KEY.test(k)) delete next[k];
  for (const id of speciesFilterIds()) next[id] = false;
  return next;
}

/** Show `species` (a focus species or a category) alone (Alt-click or long press on its chip). Layer pins are kept. */
export function showOnlySpecies(species: SpeciesFilterId): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...nothing(prev.species), [species]: true } }));
}

/** Show one non-focus taxon alone. */
export function showOnlyTaxon(taxonId: number | string): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...nothing(prev.species), [taxonKey(taxonId)]: true } }));
}

/**
 * Every animal shown again (the bar's "All"): the focus species and the categories that start on, taxon
 * overrides dropped. Categories that start off (insects, spiders, plants, other) keep their own switches; layer
 * pins are kept.
 */
export function showAllSpecies(): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
    const next = { ...prev.species };
    for (const k of Object.keys(next)) if (TAXON_KEY.test(k)) delete next[k];
    for (const id of speciesIds(activeApp())) next[id] = true;
    for (const id of CATEGORY_IDS) if (CATEGORY_DEFAULT_ON[id]) next[id] = true;
    return { ...prev, species: next };
  });
}

/** Filter keys shown, in `speciesFilterIds()` order (a missing key reads as its default). */
export function shownSpecies(filter: Readonly<Record<string, unknown>> | undefined, app: AppConfig = activeApp()): SpeciesFilterId[] {
  return speciesFilterIds(app).filter((id) => (filter?.[id] ?? keyDefault(id)) !== false);
}

/** Taxon overrides in the filter: `[taxon id, shown]`. */
export function taxonOverrides(filter: Readonly<Record<string, unknown>> | undefined): [number, boolean][] {
  const out: [number, boolean][] = [];
  for (const [k, v] of Object.entries(filter ?? {})) {
    const m = TAXON_KEY.exec(k);
    if (m && typeof v === "boolean") out.push([Number(m[1]), v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Whether the filter hides something that shows by default (the bar then offers "All"). */
export function isSpeciesFiltered(filter: Readonly<Record<string, unknown>> | undefined, app: AppConfig = activeApp()): boolean {
  if (speciesIds(app).some((id) => filter?.[id] === false)) return true;
  if (CATEGORY_IDS.some((id) => CATEGORY_DEFAULT_ON[id] && filter?.[id] === false)) return true;
  return taxonOverrides(filter).some(([, shown]) => !shown);
}

/** Pin `layer` to one species (null: follow the species filter again). */
export function setLayerSpeciesPin(layer: LayerId, species: SpeciesId | null): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
    const next = { ...prev.species };
    if (species) next[layer] = species;
    else delete next[layer];
    return { ...prev, species: next };
  });
}

export function isWindowHours(hours: unknown): hours is SightingWindowHours {
  return (SIGHTING_WINDOW_OPTIONS as readonly number[]).includes(hours as number);
}

/** The trailing sightings window (2, 7 or 30 days). */
export function setSightingHours(hours: SightingWindowHours): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => (prev.sightingHours === hours ? prev : { ...prev, sightingHours: hours }));
}

/** The window of a LAYERS value, with a missing or unknown value reading as the default. */
export function sightingHoursOf(layers: Partial<LayersState> | undefined): SightingWindowHours {
  const h = layers?.sightingHours;
  return isWindowHours(h) ? h : SIGHTING_WINDOW_HOURS;
}
