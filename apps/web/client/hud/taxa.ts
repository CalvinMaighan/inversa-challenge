/**
 * Fills the TAXA store (T44) from Axum's `taxa(ids)`: names, groups, summaries, photos and iNat pages for every
 * taxon on the published frames, so the species bar can name its chips, the sightings layer can tell a plant from
 * an animal, and the tooltip can name a dot before its evidence loads. One request per batch of unknown ids;
 * an id already loaded or in flight is never asked for twice.
 */
import { get, set } from "@calvinjs/active-state";

import { TAXA, type TaxaState, type TaxonInfo } from "client/state/taxa";
import { gqlRequest, getFrameSightings, onFrameSightings, type FrameSightings } from "client/threads/api";

export const TAXA_QUERY = `query HudTaxa($ids: [ID!]!) {
  taxa(ids: $ids) { id scientificName commonName focus iconicGroup summary photoUrl pageUrl }
}`;

/** Ids per request; Axum caps `taxa` at 500. */
const BATCH = 400;

type RawTaxon = { id: string; scientificName: string; commonName: string; focus: boolean; iconicGroup: string | null; summary: string | null; photoUrl: string | null; pageUrl: string | null };

export function normalizeTaxon(raw: RawTaxon): TaxonInfo {
  return {
    id: Number(raw.id),
    scientificName: raw.scientificName ?? "",
    commonName: raw.commonName ?? "",
    focus: raw.focus === true,
    iconicGroup: raw.iconicGroup ?? null,
    summary: raw.summary ?? null,
    photoUrl: raw.photoUrl ?? null,
    pageUrl: raw.pageUrl ?? null,
  };
}

const inFlight = new Set<number>();

/** Merge taxa into the store (also used to seed it from an evidence record's taxon). */
export function putTaxa(list: readonly TaxonInfo[]): void {
  if (list.length === 0) return;
  set<TaxaState>(TAXA, (prev = TAXA.defaults) => {
    const byId = { ...prev.byId };
    let changed = false;
    for (const t of list) {
      const key = String(t.id);
      const old = byId[key];
      if (old && old.commonName === t.commonName && old.iconicGroup === t.iconicGroup && old.summary === t.summary && old.photoUrl === t.photoUrl) continue;
      byId[key] = t;
      changed = true;
    }
    return changed ? { byId, version: prev.version + 1 } : prev;
  });
}

/** Load the taxa the store lacks. Resolves when every batch has landed (or failed; a failed id may be asked again later). */
export async function ensureTaxa(ids: Iterable<number>, request: typeof gqlRequest = gqlRequest): Promise<void> {
  const known = (get<TaxaState>(TAXA) ?? TAXA.defaults).byId;
  const missing = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && !known[String(id)] && !inFlight.has(id));
  if (missing.length === 0) return;
  for (const id of missing) inFlight.add(id);
  try {
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const data = await request<{ taxa: RawTaxon[] }>(TAXA_QUERY, { ids: batch.map(String) });
      putTaxa(data.taxa.map(normalizeTaxon));
    }
  } catch (err) {
    console.warn("[hud] taxa query failed", err);
  } finally {
    for (const id of missing) inFlight.delete(id);
  }
}

/** Distinct taxon ids on every published frame. */
export function taxonIdsOf(s: FrameSightings): number[] {
  const out = new Set<number>();
  for (let f = 0; f < s.counts.length; f++) for (const r of s.records(f)) out.add(r.taxon);
  return [...out];
}

/** Watch the published sightings and keep TAXA complete for them. Returns the unsubscribe. */
export function syncTaxa(): () => void {
  const current = getFrameSightings();
  if (current) void ensureTaxa(taxonIdsOf(current));
  return onFrameSightings((s) => void ensureTaxa(taxonIdsOf(s)));
}
