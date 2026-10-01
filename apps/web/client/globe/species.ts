/**
 * Species styling for globe primitives. Colours are hex because Cesium's `Color.fromCssColorString` does not
 * parse the oklch() theme tokens; hues are picked to stay apart from each other and from the heat ramp's
 * violet-to-yellow run.
 */
import type { SpeciesId } from "client/state/layers";
import { SPECIES_IDS } from "shared/voice/ui-tools";

/** Indexed like SPECIES_IDS (and EVF_SPECIES): python, tegu, iguana, lionfish. */
export const SPECIES_COLORS: readonly string[] = ["#e3b341", "#ff7a45", "#5fd068", "#ff5c9a"];
/** Sightings of taxa outside the four focus species. */
export const OTHER_TAXON_COLOR = "#b8c0cc";

/** EVF taxon ids are `taxa.id`, 1-based in SPECIES_IDS order (PLAN.md C4). -1 for a non-focus taxon. */
export function speciesIndexOfTaxon(taxon: number): number {
  return Number.isInteger(taxon) && taxon >= 1 && taxon <= SPECIES_IDS.length ? taxon - 1 : -1;
}

export function colorOfTaxon(taxon: number): string {
  const i = speciesIndexOfTaxon(taxon);
  return i < 0 ? OTHER_TAXON_COLOR : SPECIES_COLORS[i]!;
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

/** Whether a layer shows taxa outside the focus species: the filter's `other` key, off while the layer is pinned. */
export function otherTaxaShown(filter: Readonly<Record<string, unknown>> | undefined, layerId?: string): boolean {
  const pinned = layerId === undefined ? undefined : filter?.[layerId];
  if (typeof pinned === "string" && (SPECIES_IDS as readonly string[]).includes(pinned)) return false;
  return filter?.[OTHER_TAXA_KEY] !== false;
}

/** Filter and breakdown key for sightings of taxa outside the four focus species. */
export const OTHER_TAXA_KEY = "other";
