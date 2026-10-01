/**
 * What the globe draws by default, counted from Axum (T44): every distinct sighting of the window whose species'
 * category starts on (the focus four and every animal category; insects, spiders, plants and other wait behind
 * their switches), using the same `categoryFromAncestry` the client uses on each taxon's iNat ancestry.
 */
import { CATEGORY_DEFAULT_ON, categoryFromAncestry, type CategoryId } from "../shared/species-categories";
import type { Stack } from "./stack";

export type BBox = { west: number; south: number; east: number; north: number };
export type Window = { from: string; to: string };
type Row = { count: number; taxon: { id: string; iconicGroup: string | null; ancestorIds: string[] | null } };

const QUERY =
  "query($bbox: BBox!, $from: Time!, $to: Time!) { speciesCounts(bbox: $bbox, from: $from, to: $to, top: 500) { count taxon { id iconicGroup ancestorIds } } }";

/** Distinct sightings per category over the window, and the total the globe draws by default. */
export async function apiDefaultCount(stack: Stack, bbox: BBox, window: Window): Promise<{ drawn: number; byCategory: Record<CategoryId, number>; species: number }> {
  const { speciesCounts } = await stack.graphql<{ speciesCounts: Row[] }>(QUERY, { bbox, ...window });
  const byCategory = {} as Record<CategoryId, number>;
  let drawn = 0;
  for (const row of speciesCounts) {
    const category = categoryFromAncestry(row.taxon.ancestorIds?.map(Number), row.taxon.iconicGroup);
    byCategory[category] = (byCategory[category] ?? 0) + row.count;
    if (CATEGORY_DEFAULT_ON[category]) drawn += row.count;
  }
  return { drawn, byCategory, species: speciesCounts.length };
}
