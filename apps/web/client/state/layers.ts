import { key, set } from "@calvinjs/active-state";

import { SIGHTING_WINDOW_HOURS, SIGHTING_WINDOW_OPTIONS, type SightingWindowHours } from "shared/frames";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

export type LayerId = (typeof LAYER_IDS)[number];
export type SpeciesId = (typeof SPECIES_IDS)[number];

/**
 * Species groups outside the four focus species (T44): every other introduced animal, the plants, and insects
 * with everything else. Animals start on; plants and insects start off.
 */
export const SPECIES_GROUP_IDS = ["animals", "plants", "others"] as const;
export type SpeciesGroupId = (typeof SPECIES_GROUP_IDS)[number];

/** Species filter keys: the four focus species, then the three groups. */
export const SPECIES_FILTER_IDS = [...SPECIES_IDS, ...SPECIES_GROUP_IDS] as const;
export type SpeciesFilterId = (typeof SPECIES_FILTER_IDS)[number];

/** Filter key of one non-focus taxon (`taxa.id`): an override on top of its group. */
export const taxonKey = (taxonId: number | string): `t${string}` => `t${taxonId}`;
export const TAXON_KEY = /^t(\d+)$/;

export type LayersState = {
  /** Visibility per globe layer. */
  visible: Record<LayerId, boolean>;
  /**
   * Species filter applied to sightings and hotspots (the four focus species). Focus and group keys read as
   * shown when missing; a `t<taxon id>` key overrides its taxon's group either way (a chip hidden on its own,
   * or "only this one" with its group off). A layer id key pins that layer to one focus species, whatever the
   * booleans say (`client/globe/species.ts` `enabledSpecies`); the legend's hotspot pin writes it.
   */
  species: Record<SpeciesFilterId, boolean> & Partial<Record<LayerId, SpeciesId>> & Partial<Record<`t${string}`, boolean>>;
  /** The trailing sightings window the globe draws and the bar counts, hours (T44). */
  sightingHours: SightingWindowHours;
};

/**
 * Sightings first (T41): of the data layers only sightings start visible. Stations, alerts, hotspots and the
 * temperature rasters start hidden, a tap away under "More data (for experts)"; alerts the agent cites still
 * show as brackets. Missions and team cursors draw only what the team put there.
 */
// eslint-disable-next-line inversa/prefer-catalog-constants -- typed as LayerId, so tsc checks them against LAYER_IDS.
const HIDDEN_BY_DEFAULT: ReadonlySet<LayerId> = new Set<LayerId>(["stations", "alerts", "hotspots", "lst", "sst"]);
// eslint-disable-next-line inversa/prefer-catalog-constants -- typed as SpeciesGroupId, so tsc checks them against SPECIES_GROUP_IDS.
const GROUPS_OFF_BY_DEFAULT: ReadonlySet<SpeciesGroupId> = new Set<SpeciesGroupId>(["plants", "others"]);

const defaults: LayersState = {
  visible: Object.fromEntries(LAYER_IDS.map((id) => [id, !HIDDEN_BY_DEFAULT.has(id)])) as Record<LayerId, boolean>,
  species: Object.fromEntries(SPECIES_FILTER_IDS.map((id) => [id, !GROUPS_OFF_BY_DEFAULT.has(id as SpeciesGroupId)])) as Record<SpeciesFilterId, boolean>,
  sightingHours: SIGHTING_WINDOW_HOURS,
};

export const LAYERS = key("LAYERS", defaults);

export function setLayerVisible(layer: LayerId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, visible: { ...prev.visible, [layer]: visible } }));
}

export function setSpeciesVisible(species: SpeciesFilterId, visible: boolean): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...prev.species, [species]: visible } }));
}

/** Show or hide one non-focus taxon on its own (its chip). `null` drops the override: the taxon follows its group again. */
export function setTaxonVisible(taxonId: number | string, visible: boolean | null): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
    const next = { ...prev.species };
    if (visible === null) delete next[taxonKey(taxonId)];
    else next[taxonKey(taxonId)] = visible;
    return { ...prev, species: next };
  });
}

/** Every focus and group key off, every taxon override dropped; layer pins kept. */
function nothing(prev: LayersState["species"]): LayersState["species"] {
  const next = { ...prev };
  for (const k of Object.keys(next)) if (TAXON_KEY.test(k)) delete next[k as `t${string}`];
  for (const id of SPECIES_FILTER_IDS) next[id] = false;
  return next;
}

/** Show `species` (a focus species or a group) alone (Alt-click or long press on its chip). Layer pins are kept. */
export function showOnlySpecies(species: SpeciesFilterId): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...nothing(prev.species), [species]: true } }));
}

/** Show one non-focus taxon alone. */
export function showOnlyTaxon(taxonId: number | string): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, species: { ...nothing(prev.species), [taxonKey(taxonId)]: true } }));
}

/** Every animal shown again (the bar's "All"): focus species and animals on, taxon overrides dropped. Plants and insects keep their own switches; layer pins are kept. */
export function showAllSpecies(): void {
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => {
    const next = { ...prev.species };
    for (const k of Object.keys(next)) if (TAXON_KEY.test(k)) delete next[k as `t${string}`];
    for (const id of SPECIES_IDS) next[id] = true;
    next.animals = true;
    return { ...prev, species: next };
  });
}

/** Filter keys shown, in SPECIES_FILTER_IDS order (a missing key reads as its default). */
export function shownSpecies(filter: Readonly<Record<string, unknown>> | undefined): SpeciesFilterId[] {
  return SPECIES_FILTER_IDS.filter((id) => (filter?.[id] ?? defaults.species[id]) !== false);
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

/** Whether the filter hides any animal the bar shows by default (the bar then offers "All"). */
export function isSpeciesFiltered(filter: Readonly<Record<string, unknown>> | undefined): boolean {
  if (SPECIES_IDS.some((id) => filter?.[id] === false) || filter?.animals === false) return true;
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
