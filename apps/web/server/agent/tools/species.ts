/**
 * The app's one species: `resolveSpecies` maps the names a user types (its key, common or Latin name, or a config
 * alias) to its `taxa.id`; any other name is not tracked in the app. `speciesCountsView` is the C17 table of the
 * `species_counts` tool (capabilities.ts), whose row cites the species' newest sighting.
 */

import { z } from "zod";

import { focusSpecies, type SpeciesKey } from "@/server/agent/tools/evidence";
import { MAX_HIGHLIGHT, MAX_VIEW_ROWS, type ToolViewData } from "@/server/agent/tools/views";
import type { BBox } from "@/shared/agent/events";
import type { TableView } from "@/shared/agent/results";
import { taxonKey, type AppConfig } from "@/shared/apps";

export type GqlTaxon = {
  id: string;
  scientificName: string;
  commonName: string;
  focus: boolean;
  inatTaxonId?: string | null;
  pageUrl?: string | null;
};

/** The name a reader sees: the common name in sentence case, else the Latin name. */
export function speciesLabel(taxon: Pick<GqlTaxon, "commonName" | "scientificName">): string {
  const common = taxon.commonName?.trim();
  if (common) return common.charAt(0).toUpperCase() + common.slice(1).toLowerCase();
  return taxon.scientificName?.trim() || "Unnamed species";
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Other names people use for the app's species (lower case, singular), from the taxon's config `aliases`. */
function focusAliases(app: AppConfig): Record<string, SpeciesKey> {
  const out: Record<string, SpeciesKey> = {};
  for (const t of app.taxa) for (const alias of t.aliases ?? []) out[norm(alias)] = taxonKey(t);
  return out;
}

/** The species key a name means in `app`, if any: "python", "burmese pythons", "Python bivittatus", "red lionfish" … */
export function focusKeyOf(app: AppConfig, name: string): SpeciesKey | null {
  const whole = norm(name);
  const singular = whole.replace(/(es|s)$/, "");
  const aliases = focusAliases(app);
  for (const s of focusSpecies(app)) {
    for (const n of [whole, singular]) {
      if (n === s.key || n === norm(s.common) || n === norm(s.scientific) || n === norm(s.scientific).replace(/\/.*$/, "")) return s.key;
      const alias = aliases[n];
      if (alias) return alias;
    }
  }
  return null;
}

export type ResolvedSpecies = {
  /** `taxa.id`s to pass as the sightings `taxa` filter. */
  taxonIds: string[];
  /** Plain names of what was resolved, for the title. */
  names: string[];
  /** Names that are not the app's species. */
  unresolved: string[];
};

/** Species names to the app's taxon id. Costs no request: a name that is not the app's species is not tracked here. */
export function resolveSpecies(names: readonly string[], app: AppConfig): ResolvedSpecies {
  const focus = focusSpecies(app);
  const out: ResolvedSpecies = { taxonIds: [], names: [], unresolved: [] };
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = focusKeyOf(app, name);
    const s = key ? focus.find((f) => f.key === key) : undefined;
    if (!s) {
      out.unresolved.push(name);
      continue;
    }
    if (!out.taxonIds.includes(s.taxonId)) {
      out.taxonIds.push(s.taxonId);
      out.names.push(s.common.toLowerCase());
    }
  }
  return out;
}

export const speciesNameSchema = z.string().trim().min(1).max(80).describe("This app's species, by its key, common or scientific name.");

// ---------------------------------------------------------------- species_counts view

export const SPECIES_COUNTS_QUERY = `query AgentSpeciesCounts($bbox: BBox!, $from: Time!, $to: Time!, $top: Int) {
  speciesCounts(bbox: $bbox, from: $from, to: $to, top: $top) {
    taxon { id scientificName commonName focus inatTaxonId pageUrl }
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
    count: r.count,
    latestSighting: r.latestSightingId ? `sighting:${r.latestSightingId}` : null,
    pageUrl: r.taxon.pageUrl ?? null,
  };
}

export type SpeciesCountRow = {
  taxonId: string;
  species: string;
  scientificName: string;
  count: number;
  /** `sighting:<id>` of the newest sighting counted, the row's citation. */
  latestSighting: string | null;
  pageUrl: string | null;
};

export function speciesCountsView(rows: readonly SpeciesCountRow[], bbox: BBox, title: string): ToolViewData {
  const shown = rows.slice(0, MAX_VIEW_ROWS);
  const table: TableView = {
    view: "table",
    title,
    columns: [
      { key: "species", label: "Species", kind: "text" },
      { key: "scientific", label: "Scientific name", kind: "text" },
      { key: "count", label: "Sightings", kind: "number" },
      { key: "latest", label: "Newest record", kind: "text" },
    ],
    rows: shown.map((row) => ({
      evidenceId: row.latestSighting ?? `taxon:${row.taxonId}`,
      species: row.species,
      scientific: row.scientificName,
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
