/**
 * Species styling and filtering for globe primitives (T41, T44). Colours are hex because Cesium's
 * `Color.fromCssColorString` does not parse the oklch() theme tokens; hues are picked to stay apart from each
 * other and from the heat ramp's violet-to-yellow run.
 *
 * The four focus species keep their fixed colours. Every other taxon gets a stable colour from TAXON_PALETTE by
 * its `taxa.id`, so a brown anole is the same blue on the globe, in its chip and in the legend. Nothing is grey
 * any more: a taxon whose group is off is not drawn at all.
 */
import { SPECIES_GROUP_IDS, taxonKey, type SpeciesGroupId, type SpeciesId } from "client/state/layers";
import { isFocusTaxon, taxonGroup, type TaxonInfo } from "client/state/taxa";
import { SPECIES_IDS } from "shared/voice/ui-tools";

/** Indexed like SPECIES_IDS (and EVF_SPECIES): python, tegu, iguana, lionfish. */
export const SPECIES_COLORS: readonly string[] = ["#e3b341", "#ff7a45", "#5fd068", "#ff5c9a"];
/**
 * Stable palette for non-focus taxa, by taxon id. Twelve hues kept away from the focus amber, orange, green
 * and pink, and from the heat ramp.
 */
export const TAXON_PALETTE: readonly string[] = [
  "#4fb3ff", // sky blue
  "#c678dd", // lilac
  "#2ec4b6", // teal
  "#f4d35e", // pale yellow
  "#ef476f", // raspberry
  "#8ac926", // lime
  "#ff9f1c", // tangerine
  "#7f7fff", // periwinkle
  "#06d6a0", // mint
  "#ff85a1", // rose
  "#3bceac", // sea green
  "#b5de2b", // chartreuse
];
/** Chips of a group that is off (plants, insects) and nothing else: the only neutral left. */
export const NEUTRAL_COLOR = "#b8c0cc";
/** @deprecated T44: no dot is grey any more; kept for the welcome's chip colours. */
export const OTHER_TAXON_COLOR = NEUTRAL_COLOR;

/** EVF taxon ids are `taxa.id`, 1-based in SPECIES_IDS order (PLAN.md C4). -1 for a non-focus taxon. */
export function speciesIndexOfTaxon(taxon: number): number {
  return isFocusTaxon(taxon) ? taxon - 1 : -1;
}

export function colorOfTaxon(taxon: number): string {
  const i = speciesIndexOfTaxon(taxon);
  if (i >= 0) return SPECIES_COLORS[i]!;
  // A golden-ratio stride spreads neighbouring ids over the palette.
  return TAXON_PALETTE[Math.abs(Math.round(taxon * 7)) % TAXON_PALETTE.length]!;
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

/** Whether a species group is shown: a missing key reads as its default (animals on, plants and others off). */
export function groupShown(filter: Readonly<Record<string, unknown>> | undefined, group: SpeciesGroupId): boolean {
  const v = filter?.[group];
  return typeof v === "boolean" ? v : group === "animals";
}

/**
 * Whether one non-focus taxon is drawn: its own override key when set, else its group's switch. While a layer
 * is pinned to one focus species nothing else draws.
 */
export function taxonShown(filter: Readonly<Record<string, unknown>> | undefined, taxon: number, byId: Readonly<Record<string, TaxonInfo>>, layerId?: string): boolean {
  const pinned = layerId === undefined ? undefined : filter?.[layerId];
  if (typeof pinned === "string" && (SPECIES_IDS as readonly string[]).includes(pinned)) return false;
  const own = filter?.[taxonKey(taxon)];
  if (typeof own === "boolean") return own;
  return groupShown(filter, taxonGroup(byId, taxon));
}

/** Every drawn record passes this: focus species by their keys, any other taxon by `taxonShown`. */
export function recordShown(filter: Readonly<Record<string, unknown>> | undefined, taxon: number, byId: Readonly<Record<string, TaxonInfo>>, layerId?: string): boolean {
  const s = speciesIndexOfTaxon(taxon);
  if (s >= 0) return enabledSpecies(filter, layerId).includes(s);
  return taxonShown(filter, taxon, byId, layerId);
}

export { SPECIES_GROUP_IDS };
