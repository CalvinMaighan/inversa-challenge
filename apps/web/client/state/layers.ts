import { key, set } from "@calvinjs/active-state";

import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

export type LayerId = (typeof LAYER_IDS)[number];
export type SpeciesId = (typeof SPECIES_IDS)[number];

export type LayersState = {
  /** Visibility per globe layer. */
  visible: Record<LayerId, boolean>;
  /**
   * Species filter applied to sightings and hotspots. A layer id key pins that layer to one species, whatever
   * the booleans say (`client/globe/species.ts` `enabledSpecies`); the legend's hotspot pin writes it.
   */
  species: Record<SpeciesId, boolean> & Partial<Record<LayerId, SpeciesId>>;
};

/** Surface temperature rasters start hidden: they cover the imagery and only matter for the cold-snap story. */
// eslint-disable-next-line inversa/prefer-catalog-constants -- typed as LayerId, so tsc checks them against LAYER_IDS.
const HIDDEN_BY_DEFAULT: ReadonlySet<LayerId> = new Set<LayerId>(["lst", "sst"]);

const defaults: LayersState = {
  visible: Object.fromEntries(LAYER_IDS.map((id) => [id, !HIDDEN_BY_DEFAULT.has(id)])) as Record<LayerId, boolean>,
  species: Object.fromEntries(SPECIES_IDS.map((id) => [id, true])) as Record<SpeciesId, boolean>,
};

export const LAYERS = key("LAYERS", defaults);

export function setLayerVisible(layer: LayerId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, visible: { ...prev.visible, [layer]: visible } }));
}

export function setSpeciesVisible(species: SpeciesId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...prev.species, [species]: visible } }));
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
