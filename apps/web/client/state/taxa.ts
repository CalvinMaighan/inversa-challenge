import { key } from "@calvinjs/active-state";

import { categoryFromAncestry, FOCUS_CATEGORIES, type CategoryId } from "shared/species-categories";
import { SPECIES_IDS } from "shared/voice/ui-tools";

/**
 * What the client knows about a taxon (T44): the GraphQL `Taxon`, keyed by `taxa.id` (the EVF2 record's
 * `taxon`), with its category derived from the iNat ancestry. Filled by `client/hud/taxa.ts` from the ids on
 * the published frames; read by the species bar, the sightings layer (category filter, icon and colour), the
 * tooltip and the legend.
 */
export type TaxonInfo = {
  id: number;
  scientificName: string;
  commonName: string;
  focus: boolean;
  /** iNat iconic group (Reptilia, Aves, Plantae, …) or null when unknown. */
  iconicGroup: string | null;
  /** iNat ancestor taxon ids, root first; null when unknown. */
  ancestorIds: readonly number[] | null;
  /** Snakes, lizards, …: from the ancestry, else the iconic group, else `other`. */
  category: CategoryId;
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

const defaults: TaxaState = { byId: {}, version: 0 };

export const TAXA = key("TAXA", defaults);

/** `taxa.id` 1-4 are the focus species, in SPECIES_IDS order (PLAN.md C4). */
export function isFocusTaxon(taxonId: number): boolean {
  return Number.isInteger(taxonId) && taxonId >= 1 && taxonId <= SPECIES_IDS.length;
}

/**
 * The category of a taxon id: the focus four are known without the store; any other taxon reads the store, and
 * one not loaded yet is `null` (drawn with the generic icon until it arrives).
 */
export function taxonCategory(byId: Readonly<Record<string, TaxonInfo>>, taxonId: number): CategoryId | null {
  if (isFocusTaxon(taxonId)) return FOCUS_CATEGORIES[taxonId - 1]!;
  return byId[String(taxonId)]?.category ?? null;
}

/** The category of a raw taxon record (an evidence record's `taxon`, a GraphQL row). */
export function categoryOfTaxon(taxon: { ancestorIds?: readonly (number | string)[] | null; iconicGroup?: string | null } | null | undefined): CategoryId {
  const ids = taxon?.ancestorIds?.map(Number).filter((n) => Number.isFinite(n));
  return categoryFromAncestry(ids, taxon?.iconicGroup);
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
