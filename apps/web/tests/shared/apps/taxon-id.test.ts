/**
 * The taxon id has one source: the config's `taxa[].dbId`, which is the `taxa.id` the API's migration seeds
 * (and `App::resolve_taxa` checks at boot). Every stub and fixture the agent is tested against must carry the same
 * id, or a wrong id in the agent cannot show up in the eval (BUG1 defect 1: lionfish queried taxon 1, the API's is 4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import lionfishFixture from "../../../eval/fixtures/lionfish.json";
import pythonFixture from "../../../eval/fixtures/graphql.json";
import { focusSpecies } from "@/server/agent/tools/evidence";
import { resolveSpecies } from "@/server/agent/tools/species";
import { APP_IDS, getApp } from "@/shared/apps";

const SEED = join(import.meta.dir, "../../../../../api/migrations/observations/0001_init.sql");

/** `taxa.id` by scientific name from the migration's `insert into taxa (id, scientific_name, …) values (1, 'Python bivittatus', …)`. */
function seededIds(): Record<string, number> {
  const sql = readFileSync(SEED, "utf8");
  const block = /insert into taxa \(id, scientific_name[^;]*;/.exec(sql)?.[0] ?? "";
  const out: Record<string, number> = {};
  for (const m of block.matchAll(/\((\d+), '([^']+)'/g)) out[m[2]!] = Number(m[1]);
  return out;
}

describe("taxon id", () => {
  const species = APP_IDS.map(getApp).filter((app) => app.taxa.length > 0);

  test("taxon id: each species app's dbId is the id the API's migration seeds for that species", () => {
    const seed = seededIds();
    expect(Object.keys(seed).length).toBeGreaterThan(0);
    for (const app of species) {
      for (const t of app.taxa) expect({ app: app.id, taxon: t.id, dbId: t.dbId }).toEqual({ app: app.id, taxon: t.id, dbId: seed[t.scientificName] });
    }
    expect(getApp("lionfish").taxa[0]!.dbId).toBe(4);
    expect(getApp("python").taxa[0]!.dbId).toBe(1);
  });

  test("taxon id: the agent filters sightings by the config dbId, by any name of the species", () => {
    for (const app of species) {
      expect(focusSpecies(app).map((s) => s.taxonId)).toEqual(app.taxa.map((t) => String(t.dbId)));
      expect(resolveSpecies([app.taxa[0]!.name, app.taxa[0]!.scientificName], app).taxonIds).toEqual([String(app.taxa[0]!.dbId)]);
    }
    expect(resolveSpecies(["lionfish"], getApp("lionfish")).taxonIds).toEqual(["4"]);
  });

  test("taxon id: every eval stub and fixture carries the config dbId for its app", () => {
    const lionfish = String(getApp("lionfish").taxa[0]!.dbId);
    expect(Object.keys(lionfishFixture.taxa)).toEqual([lionfish]);
    expect(new Set(lionfishFixture.sightings.map((s) => s.taxon))).toEqual(new Set([lionfish]));
    const python = String(getApp("python").taxa[0]!.dbId);
    expect(Object.keys(pythonFixture.taxa)).toContain(python);
    expect(pythonFixture.sightings.every((s) => s.taxon === python)).toBe(true);
  });
});
