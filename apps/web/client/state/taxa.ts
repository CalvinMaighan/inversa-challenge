import { key } from "@calvinjs/active-state";

import { SPECIES_IDS } from "shared/voice/ui-tools";

import type { SpeciesGroupId } from "./layers";

/**
 * What the client knows about a taxon (T44): the GraphQL `Taxon`, keyed by `taxa.id` (the EVF2 record's
 * `taxon`). Filled by `client/hud/TaxaSync` from the ids on the published frames; read by the species bar, the
 * sightings layer (group filter and colour), the tooltip and the legend.
 */
export type TaxonInfo = {
  id: number;
  scientificName: string;
  commonName: string;
  focus: boolean;
  /** iNat iconic group (Reptilia, Aves, Plantae, …) or null when unknown. */
  iconicGroup: string | null;
  summary: string | null;
  /** Same-origin photo (`/v1/media/taxon/<id>`). */
  photoUrl: string | null;
  /** iNaturalist taxon page. */
  pageUrl: string | null;
};

export type TaxaState = {
  byId: Record<string, TaxonInfo>;
  /** Bumped on every write, so layers can key redraws on it. */
  version: number;
};

export const TAXA = key<TaxaState>("TAXA", { byId: {}, version: 0 });

/** iNat groups that count as animals for the bar and the `animals` filter key. */
export const ANIMAL_GROUPS: readonly string[] = ["Reptilia", "Amphibia", "Aves", "Mammalia", "Actinopterygii", "Mollusca"];
export const PLANT_GROUPS: readonly string[] = ["Plantae", "Fungi"];

/** Which filter group a taxon belongs to. An unknown group (not yet loaded, or `other`) is "others". */
export function groupOf(group: string | null | undefined): SpeciesGroupId {
  if (!group) return "others";
  if (ANIMAL_GROUPS.includes(group)) return "animals";
  if (PLANT_GROUPS.includes(group)) return "plants";
  return "others";
}

/** Group of a taxon id in the store; a taxon not loaded yet reads as an animal (it is drawn until known). */
export function taxonGroup(byId: Readonly<Record<string, TaxonInfo>>, taxonId: number): SpeciesGroupId {
  if (isFocusTaxon(taxonId)) return "animals";
  const info = byId[String(taxonId)];
  return info ? groupOf(info.iconicGroup) : "animals";
}

/** `taxa.id` 1-4 are the focus species, in SPECIES_IDS order (PLAN.md C4). */
export function isFocusTaxon(taxonId: number): boolean {
  return Number.isInteger(taxonId) && taxonId >= 1 && taxonId <= SPECIES_IDS.length;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The name a newcomer reads: the common name in sentence case ("Brown anole"), else the scientific name. Never
 * a placeholder like "Other introduced species".
 */
export function taxonName(info: Pick<TaxonInfo, "commonName" | "scientificName"> | null | undefined, fallback = "Unnamed species"): string {
  const common = info?.commonName?.trim();
  // iNat capitalises every word ("Brown Anole"); the card reads better in sentence case.
  if (common) return cap(common.charAt(0) + common.slice(1).toLowerCase());
  const sci = info?.scientificName?.trim();
  return sci || fallback;
}

/** Plain words for an iNat group, for chips and cards. */
export const GROUP_WORDS: Record<string, string> = {
  Reptilia: "reptile",
  Amphibia: "amphibian",
  Aves: "bird",
  Mammalia: "mammal",
  Actinopterygii: "fish",
  Mollusca: "snail or mollusc",
  Insecta: "insect",
  Arachnida: "spider or arachnid",
  Plantae: "plant",
  Fungi: "fungus",
};
