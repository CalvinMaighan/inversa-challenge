/**
 * Species beyond the focus four (T44): `resolveSpecies` turns any species name the user types into `taxa.id`s
 * (the focus keys first, then Axum's `taxa(q)` name search, then iNaturalist's autocomplete for a name the
 * database has never seen), and `speciesCountsView` is the C17 table of the `species_counts` tool
 * (capabilities.ts), whose rows cite each species' newest sighting.
 */

import { z } from "zod";

import { SPECIES, speciesByKey, type SpeciesKey } from "@/server/agent/tools/evidence";
import { gql } from "@/server/agent/tools/gql";
import { MAX_HIGHLIGHT, MAX_VIEW_ROWS, type ToolViewData } from "@/server/agent/tools/views";
import type { BBox } from "@/shared/agent/events";
import type { TableView } from "@/shared/agent/results";
import { SPECIES_IDS } from "@/shared/voice/ui-tools";

const [, , , LIONFISH] = SPECIES_IDS;

export const INAT_AUTOCOMPLETE = "https://api.inaturalist.org/v1/taxa/autocomplete";
const INAT_TIMEOUT_MS = 8_000;

/** iNat iconic groups behind each plain group word. */
export const GROUP_WORDS = ["animals", "plants", "others", "all"] as const;
export type GroupWord = (typeof GROUP_WORDS)[number];
export const GROUPS_OF: Record<Exclude<GroupWord, "all">, string[]> = {
  animals: ["Reptilia", "Amphibia", "Aves", "Mammalia", "Actinopterygii", "Mollusca"],
  plants: ["Plantae", "Fungi"],
  others: ["Insecta", "Arachnida", "other"],
};

export type GqlTaxon = {
  id: string;
  scientificName: string;
  commonName: string;
  focus: boolean;
  inatTaxonId?: string | null;
  iconicGroup?: string | null;
  summary?: string | null;
  photoUrl?: string | null;
  pageUrl?: string | null;
};

const TAXA_QUERY = `query AgentTaxa($q: String) {
  taxa(q: $q) { id scientificName commonName focus inatTaxonId iconicGroup pageUrl }
}`;

/** The name a reader sees: the common name in sentence case, else the Latin name. */
export function speciesLabel(taxon: Pick<GqlTaxon, "commonName" | "scientificName">): string {
  const common = taxon.commonName?.trim();
  if (common) return common.charAt(0).toUpperCase() + common.slice(1).toLowerCase();
  return taxon.scientificName?.trim() || "Unnamed species";
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The focus key a name means, if any: "python", "burmese python", "Python bivittatus", "tegus" … */
export function focusKeyOf(name: string): SpeciesKey | null {
  const n = norm(name).replace(/s$/, "");
  for (const s of SPECIES) {
    if (n === s.key || n === norm(s.common).replace(/s$/, "") || n === norm(s.scientific)) return s.key;
    if (n.endsWith(` ${s.key}`) && s.key !== LIONFISH) return s.key;
  }
  // "red lionfish", "lionfishes", "Pterois volitans": the lionfish row stands for the genus.
  if (new RegExp(`^(red )?${LIONFISH}(es)?$`).test(norm(name)) || /^pterois/.test(norm(name))) return LIONFISH;
  return null;
}

/** Best local match for a name among `taxa(q)` rows: exact common or Latin name first, else the first row. */
export function pickTaxon(name: string, rows: GqlTaxon[]): GqlTaxon | null {
  const n = norm(name);
  return rows.find((t) => norm(t.commonName) === n || norm(t.scientificName) === n) ?? rows[0] ?? null;
}

type InatHit = { id: number; name: string; preferred_common_name?: string | null; iconic_taxon_name?: string | null };

/** iNaturalist's autocomplete for a name the database has never seen; null on any failure (the user still gets an answer). */
export async function inatAutocomplete(name: string, signal?: AbortSignal): Promise<InatHit | null> {
  try {
    const timeout = AbortSignal.timeout(INAT_TIMEOUT_MS);
    const res = await fetch(`${INAT_AUTOCOMPLETE}?q=${encodeURIComponent(name)}&per_page=1`, {
      headers: { accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: InatHit[] };
    const hit = body.results?.[0];
    return hit && typeof hit.id === "number" && typeof hit.name === "string" ? hit : null;
  } catch {
    return null;
  }
}

export type ResolvedSpecies = {
  /** `taxa.id`s to pass as the sightings `taxa` filter. */
  taxonIds: string[];
  /** Plain names of what was resolved, for the title. */
  names: string[];
  /** Names that match nothing in the database (with what iNat calls them, when it knows them). */
  unresolved: { asked: string; inat: string | null }[];
};

/**
 * Species names to taxon ids. Focus keys cost no request; any other name asks Axum's `taxa(q)`, and a name
 * Axum does not know asks iNaturalist what it is called, then Axum again by that name (and iNat id).
 */
export async function resolveSpecies(names: readonly string[], signal?: AbortSignal, lookup: typeof inatAutocomplete = inatAutocomplete): Promise<ResolvedSpecies> {
  const out: ResolvedSpecies = { taxonIds: [], names: [], unresolved: [] };
  const add = (id: string, label: string) => {
    if (!out.taxonIds.includes(id)) {
      out.taxonIds.push(id);
      out.names.push(label);
    }
  };
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = focusKeyOf(name);
    if (key) {
      const s = speciesByKey(key);
      add(s.taxonId, s.common.toLowerCase());
      continue;
    }
    const local = await gql<{ taxa: GqlTaxon[] }>("AgentTaxa", TAXA_QUERY, { q: name }, signal);
    const found = pickTaxon(name, local.taxa);
    if (found) {
      add(found.id, speciesLabel(found).toLowerCase());
      continue;
    }
    const hit = await lookup(name, signal);
    if (hit) {
      const again = await gql<{ taxa: GqlTaxon[] }>("AgentTaxa", TAXA_QUERY, { q: hit.name }, signal);
      const byInat = again.taxa.find((t) => t.inatTaxonId === String(hit.id)) ?? pickTaxon(hit.name, again.taxa);
      if (byInat) {
        add(byInat.id, speciesLabel(byInat).toLowerCase());
        continue;
      }
    }
    out.unresolved.push({ asked: name, inat: hit ? `${hit.preferred_common_name ?? hit.name} (${hit.name}, iNaturalist taxon ${hit.id})` : null });
  }
  return out;
}

export const speciesNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe("A species: python | tegu | iguana | lionfish, or any other species' common or scientific name (brown anole, Cuban tree frog, Anolis sagrei).");

// ---------------------------------------------------------------- species_counts view

export const SPECIES_COUNTS_QUERY = `query AgentSpeciesCounts($bbox: BBox!, $from: Time!, $to: Time!, $groups: [String!], $top: Int) {
  speciesCounts(bbox: $bbox, from: $from, to: $to, groups: $groups, top: $top) {
    taxon { id scientificName commonName focus inatTaxonId iconicGroup summary pageUrl }
    count
    latestSightingId
  }
  feeds { ...FeedFields }
}
`;

export type GqlSpeciesCount = { taxon: GqlTaxon; count: number; latestSightingId: string | null };

/** A `speciesCounts` row as the tool and its view carry it. */
export function speciesCountRow(r: GqlSpeciesCount): SpeciesCountRow {
  return {
    taxonId: r.taxon.id,
    species: speciesLabel(r.taxon),
    scientificName: r.taxon.scientificName,
    group: r.taxon.iconicGroup ?? null,
    focus: r.taxon.focus,
    count: r.count,
    latestSighting: r.latestSightingId ? `sighting:${r.latestSightingId}` : null,
    pageUrl: r.taxon.pageUrl ?? null,
    summary: r.taxon.summary ?? null,
  };
}

export type SpeciesCountRow = {
  taxonId: string;
  species: string;
  scientificName: string;
  group: string | null;
  focus: boolean;
  count: number;
  /** `sighting:<id>` of the newest sighting counted, the row's citation. */
  latestSighting: string | null;
  pageUrl: string | null;
  summary: string | null;
};

export function speciesCountsView(rows: readonly SpeciesCountRow[], bbox: BBox, title: string): ToolViewData {
  const shown = rows.slice(0, MAX_VIEW_ROWS);
  const table: TableView = {
    view: "table",
    title,
    columns: [
      { key: "species", label: "Species", kind: "text" },
      { key: "scientific", label: "Scientific name", kind: "text" },
      { key: "group", label: "Group", kind: "text" },
      { key: "count", label: "Sightings", kind: "number" },
      { key: "latest", label: "Newest record", kind: "text" },
    ],
    rows: shown.map((row) => ({
      evidenceId: row.latestSighting ?? `taxon:${row.taxonId}`,
      species: row.species,
      scientific: row.scientificName,
      group: row.group,
      count: row.count,
      latest: row.latestSighting,
      // The ↗ column: the species' page at iNaturalist.
      sourcePageUrl: row.pageUrl,
    })),
    ...(rows.length > shown.length ? { total: rows.length } : {}),
  };
  return {
    result: table,
    highlight: shown.map((row) => row.latestSighting).filter((id): id is string => id !== null).slice(0, MAX_HIGHLIGHT),
    bbox,
  };
}

