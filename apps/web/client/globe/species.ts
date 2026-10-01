/**
 * Species styling and filtering for globe primitives (T41, T44). Colours are hex because Cesium's
 * `Color.fromCssColorString` does not parse the oklch() theme tokens.
 *
 * The four focus species keep their fixed colours and draw their category's icon (a python is a snake, a tegu
 * and an iguana are lizards, a lionfish is a fish). Every other taxon draws its category's icon in the
 * category's label colour (`shared/species-categories.ts`), so a brown anole is the same teal lizard on the
 * globe, in its chip, in the popover and in the legend. Nothing is grey: a category that is off is not drawn.
 */
import { taxonKey, type SpeciesId } from "client/state/layers";
import { isFocusTaxon, taxonCategory, type TaxonInfo } from "client/state/taxa";
import { CATEGORY_COLORS, CATEGORY_DEFAULT_ON, type CategoryId } from "shared/species-categories";
import { SPECIES_IDS } from "shared/voice/ui-tools";

/** Indexed like SPECIES_IDS (and EVF_SPECIES): python, tegu, iguana, lionfish. */
export const SPECIES_COLORS: readonly string[] = ["#e3b341", "#ff7a45", "#5fd068", "#ff5c9a"];
/** Chips and markers of something not yet known (a taxon the store has not loaded): the only neutral left. */
export const NEUTRAL_COLOR = "#b8c0cc";

/** EVF taxon ids are `taxa.id`, 1-based in SPECIES_IDS order (PLAN.md C4). -1 for a non-focus taxon. */
export function speciesIndexOfTaxon(taxon: number): number {
  return isFocusTaxon(taxon) ? taxon - 1 : -1;
}

/** The marker colour of a taxon: its focus colour, else its category's label colour, else neutral until loaded. */
export function colorOfTaxon(taxon: number, byId: Readonly<Record<string, TaxonInfo>> = {}): string {
  const i = speciesIndexOfTaxon(taxon);
  if (i >= 0) return SPECIES_COLORS[i]!;
  const category = taxonCategory(byId, taxon);
  return category ? CATEGORY_COLORS[category] : NEUTRAL_COLOR;
}

/**
 * Species indices a layer shows, in SPECIES_IDS order. The LAYERS filter holds a boolean per species; the voice
 * `toggle_layer` tool may also pin one layer to one species by writing `species[<layer id>] = <species id>`,
 * which wins for that layer.
 */
export function enabledSpecies(filter: Readonly<Record<string, unknown>> | undefined, layerId?: string): number[] {
  const pinned = layerId === undefined ? undefined : filter?.[layerId];
  if (typeof pinned === "string") {
    const i = (SPECIES_IDS as readonly string[]).indexOf(pinned);
    if (i >= 0) return [i];
  }
  const out: number[] = [];
  SPECIES_IDS.forEach((id: SpeciesId, i) => {
    if (filter?.[id] !== false) out.push(i);
  });
  return out;
}

/** Whether a category is shown: a missing key reads as its default (animals on; insects, spiders, plants and other off). */
export function categoryShown(filter: Readonly<Record<string, unknown>> | undefined, category: CategoryId): boolean {
  const v = filter?.[category];
  return typeof v === "boolean" ? v : CATEGORY_DEFAULT_ON[category];
}

/**
 * Whether one non-focus taxon is drawn: its own override key when set, else its category's switch. A taxon not
 * loaded yet is drawn (with the generic icon) so nothing vanishes while the store fills. While a layer is pinned
 * to one focus species nothing else draws.
 */
export function taxonShown(filter: Readonly<Record<string, unknown>> | undefined, taxon: number, byId: Readonly<Record<string, TaxonInfo>>, layerId?: string): boolean {
  const pinned = layerId === undefined ? undefined : filter?.[layerId];
  if (typeof pinned === "string" && (SPECIES_IDS as readonly string[]).includes(pinned)) return false;
  const own = filter?.[taxonKey(taxon)];
  if (typeof own === "boolean") return own;
  const category = taxonCategory(byId, taxon);
  return category === null ? true : categoryShown(filter, category);
}

/** Every drawn record passes this: focus species by their keys, any other taxon by `taxonShown`. */
export function recordShown(filter: Readonly<Record<string, unknown>> | undefined, taxon: number, byId: Readonly<Record<string, TaxonInfo>>, layerId?: string): boolean {
  const s = speciesIndexOfTaxon(taxon);
  if (s >= 0) return enabledSpecies(filter, layerId).includes(s);
  return taxonShown(filter, taxon, byId, layerId);
}
