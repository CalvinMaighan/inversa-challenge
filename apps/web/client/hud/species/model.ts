/**
 * The species bar's models (T44), pure over the LAYERS filter, the TAXA store and the sightings layer's
 * breakdown (counts per taxon id over the window, before the filter):
 *
 * - `speciesChips`: the four focus species pinned first, the TOP_ANIMAL_CHIPS most-seen other animals, then the
 *   "Other" chip that opens the categories.
 * - `categoryRows`: every category (snakes, lizards, …, plants, other) with its icon colour, count, switch and
 *   its most-seen species, each with its own switch.
 */
import { colorOfTaxon, categoryShown, SPECIES_COLORS, taxonShown } from "client/globe/species";
import { type LayersState, type SpeciesFilterId } from "client/state/layers";
import { isFocusTaxon, taxonCategory, taxonName, type TaxonInfo } from "client/state/taxa";
import { ANIMAL_CATEGORIES, CATEGORY_COLORS, CATEGORY_IDS, CATEGORY_LABELS, FOCUS_CATEGORIES, type CategoryId } from "shared/species-categories";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import { SPECIES_GUIDE } from "../help/content";

const [SIGHTINGS] = LAYER_IDS;
/** Non-focus animal chips in the bar: the most-seen taxa of the window. A phone shows the first MOBILE_ANIMAL_CHIPS of them. */
export const TOP_ANIMAL_CHIPS = 6;
export const MOBILE_ANIMAL_CHIPS = 3;
/** Species listed under a category in the popover. */
export const TOP_CATEGORY_SPECIES = 8;
/** The "Other" chip's key and guide entry (SPECIES_GUIDE's fifth row). */
export const OTHER_CHIP: CategoryId = "other";

/** One chip of the bar: a focus species, a top animal, or the "Other" chip. */
export type ChipModel = {
  /** `python`…`lionfish`, `t<taxon id>`, or `other`. */
  key: string;
  /** What the chip toggles; the "Other" chip opens the categories instead. */
  target: { kind: "species"; id: SpeciesFilterId } | { kind: "taxon"; id: number } | { kind: "categories" };
  name: string;
  /** The description line under the name on hover. */
  full: string;
  line: string;
  color: string;
  category: CategoryId;
  on: boolean;
  count: number | null;
  /** Rank among the non-focus animal chips (0 = most seen); absent on focus chips and "Other". */
  rank?: number;
};

export type CategorySpecies = { id: number; name: string; count: number; on: boolean };

export type CategoryRow = {
  id: CategoryId;
  label: string;
  color: string;
  on: boolean;
  /** Sightings of the category in the window (null before the globe reported). */
  count: number | null;
  /** Its most-seen species, most first. */
  species: CategorySpecies[];
};

/** First sentence of a taxon summary, for the chip's one-line description. */
export function firstSentence(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  return (m ? m[1]! : t).trim();
}

type Seen = { id: number; n: number; info: TaxonInfo | undefined; category: CategoryId };

/** Every non-focus taxon of the breakdown with its count and category (a taxon not loaded yet counts as `other`). */
function seenTaxa(taxa: Readonly<Record<string, TaxonInfo>>, breakdown: Readonly<Record<string, number>> | null): Seen[] {
  const out: Seen[] = [];
  for (const [key, n] of Object.entries(breakdown ?? {})) {
    const id = Number(key);
    if (!Number.isInteger(id) || isFocusTaxon(id)) continue;
    out.push({ id, n, info: taxa[key], category: taxonCategory(taxa, id) ?? "other" });
  }
  return out.sort((a, b) => b.n - a.n || a.id - b.id);
}

export function speciesChips(filter: LayersState["species"], taxa: Readonly<Record<string, TaxonInfo>>, breakdown: Readonly<Record<string, number>> | null): ChipModel[] {
  const count = (key: string) => (breakdown ? (breakdown[key] ?? 0) : null);
  const chips: ChipModel[] = SPECIES_IDS.map((id, i) => {
    const guide = SPECIES_GUIDE[i]!;
    return { key: id, target: { kind: "species", id }, name: guide.name, full: guide.full, line: guide.line, color: SPECIES_COLORS[i]!, category: FOCUS_CATEGORIES[i]!, on: filter[id] !== false, count: count(String(i + 1)) };
  });
  const seen = seenTaxa(taxa, breakdown);
  const animals = seen.filter((s) => s.n > 0 && ANIMAL_CATEGORIES.includes(s.category));
  for (const [rank, { id, n, info, category }] of animals.slice(0, TOP_ANIMAL_CHIPS).entries()) {
    const name = taxonName(info, `Species ${id}`);
    chips.push({
      key: `t${id}`,
      rank,
      target: { kind: "taxon", id },
      name,
      full: name,
      line: firstSentence(info?.summary) ?? (info?.scientificName ? `${info.scientificName}, an introduced species` : "an introduced animal people reported"),
      color: colorOfTaxon(id, taxa),
      category,
      on: taxonShown(filter, id, taxa, SIGHTINGS),
      count: breakdown ? n : null,
    });
  }
  const other = SPECIES_GUIDE[SPECIES_IDS.length]!;
  chips.push({
    key: OTHER_CHIP,
    target: { kind: "categories" },
    name: other.name,
    full: other.full,
    line: other.line,
    color: CATEGORY_COLORS.other,
    category: OTHER_CHIP,
    on: CATEGORY_IDS.some((id) => categoryShown(filter, id)),
    count: breakdown ? seen.reduce((sum, s) => sum + s.n, 0) : null,
  });
  return chips;
}

/** The categories popover's rows, in CATEGORY_IDS order, each with its most-seen species. */
export function categoryRows(filter: LayersState["species"], taxa: Readonly<Record<string, TaxonInfo>>, breakdown: Readonly<Record<string, number>> | null): CategoryRow[] {
  const seen = seenTaxa(taxa, breakdown);
  return CATEGORY_IDS.map((id) => {
    const mine = seen.filter((s) => s.category === id);
    return {
      id,
      label: CATEGORY_LABELS[id],
      color: CATEGORY_COLORS[id],
      on: categoryShown(filter, id),
      count: breakdown ? mine.reduce((sum, s) => sum + s.n, 0) : null,
      species: mine.slice(0, TOP_CATEGORY_SPECIES).map((s) => ({ id: s.id, name: taxonName(s.info, `Species ${s.id}`), count: s.n, on: taxonShown(filter, s.id, taxa, SIGHTINGS) })),
    };
  });
}
