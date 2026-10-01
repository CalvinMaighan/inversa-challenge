import { key, set } from "@calvinjs/active-state";

import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

export type LayerId = (typeof LAYER_IDS)[number];
export type SpeciesId = (typeof SPECIES_IDS)[number];

/** Species filter keys: the four focus species, then `other` for every other introduced taxon. */
export const SPECIES_FILTER_IDS = [...SPECIES_IDS, "other"] as const;
export type SpeciesFilterId = (typeof SPECIES_FILTER_IDS)[number];

export type LayersState = {
  /** Visibility per globe layer. */
  visible: Record<LayerId, boolean>;
  /**
   * Species filter applied to sightings (all five keys) and hotspots (the four focus species). A missing key
   * reads as shown. A layer id key pins that layer to one species, whatever the booleans say
   * (`client/globe/species.ts` `enabledSpecies`); the legend's hotspot pin writes it.
   */
  species: Record<SpeciesFilterId, boolean> & Partial<Record<LayerId, SpeciesId>>;
};

/**
 * Sightings first (T41): of the data layers only sightings start visible. Stations, alerts, hotspots and the
 * temperature rasters start hidden, a tap away under "More data (for experts)"; alerts the agent cites still
 * show as brackets. Missions and team cursors draw only what the team put there.
 */
// eslint-disable-next-line inversa/prefer-catalog-constants -- typed as LayerId, so tsc checks them against LAYER_IDS.
const HIDDEN_BY_DEFAULT: ReadonlySet<LayerId> = new Set<LayerId>(["stations", "alerts", "hotspots", "lst", "sst"]);

const defaults: LayersState = {
  visible: Object.fromEntries(LAYER_IDS.map((id) => [id, !HIDDEN_BY_DEFAULT.has(id)])) as Record<LayerId, boolean>,
  species: Object.fromEntries(SPECIES_FILTER_IDS.map((id) => [id, true])) as Record<SpeciesFilterId, boolean>,
};

export const LAYERS = key("LAYERS", defaults);

export function setLayerVisible(layer: LayerId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, visible: { ...prev.visible, [layer]: visible } }));
}

export function setSpeciesVisible(species: SpeciesFilterId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...prev.species, [species]: visible } }));
}

/** Show `species` alone (Alt-click or long press on its chip). Layer pins are kept. */
export function showOnlySpecies(species: SpeciesFilterId): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({
    ...prev,
    species: { ...prev.species, ...Object.fromEntries(SPECIES_FILTER_IDS.map((id) => [id, id === species])) },
  }));
}

/** Every species shown again (the bar's "All"). Layer pins are kept. */
export function showAllSpecies(): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({
    ...prev,
    species: { ...prev.species, ...Object.fromEntries(SPECIES_FILTER_IDS.map((id) => [id, true])) },
  }));
}

/** Filter keys shown, in SPECIES_FILTER_IDS order. */
export function shownSpecies(filter: Readonly<Record<string, unknown>> | undefined): SpeciesFilterId[] {
  return SPECIES_FILTER_IDS.filter((id) => filter?.[id] !== false);
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
