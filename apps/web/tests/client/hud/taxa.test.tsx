import { describe, expect, test } from "bun:test";
import { PYTHON_LAYERS, SPECIES_COLORS, selectPython } from "@/tests/client/python-app";
import { get, init, set } from "@calvinjs/active-state";

import { categoryOfTaxon, isFocusTaxon, TAXA, taxonCategory, taxonName, type TaxaState, type TaxonInfo } from "client/state/taxa";
import { ensureTaxa, normalizeTaxon, putTaxa, taxonIdsOf } from "client/hud/taxa";
import { categoryRows, firstSentence, speciesChips, TOP_ANIMAL_CHIPS, TOP_CATEGORY_SPECIES } from "client/hud/species/model";
import { colorOfTaxon, NEUTRAL_COLOR } from "client/globe/species";
import { state } from "client/state";
import { CATEGORY_ANCESTORS, CATEGORY_COLORS, CATEGORY_IDS, type CategoryId } from "shared/species-categories";
import type { SightingRecord } from "shared/frames";

selectPython();

init(state);

/** A taxon of `category`, with an ancestry that puts it there (null ancestry: the iconic group alone). */
const taxon = (id: number, commonName: string, category: CategoryId | null, summary: string | null = null, iconicGroup: string | null = "Reptilia"): TaxonInfo => {
  const ancestorIds = category && category !== "other" ? [48460, 1, CATEGORY_ANCESTORS[category]] : null;
  return {
    id,
    scientificName: `Genus species${id}`,
    commonName,
    focus: id <= 4,
    iconicGroup,
    ancestorIds,
    category: categoryOfTaxon({ ancestorIds, iconicGroup }),
    summary,
    photoUrl: null,
    pageUrl: `https://www.inaturalist.org/taxa/${id}`,
  };
};

describe("taxa store (T44)", () => {
  test("names, categories and the focus ids", () => {
    expect(taxonName({ commonName: "Brown Anole", scientificName: "Anolis sagrei" })).toBe("Brown anole");
    expect(taxonName({ commonName: "", scientificName: "Anolis sagrei" })).toBe("Anolis sagrei");
    expect(taxonName({ commonName: "", scientificName: "" })).toBe("Unnamed species");
    expect(taxonName(null, "Species 9")).toBe("Species 9");
    expect([0, 1, 4, 5].map(isFocusTaxon)).toEqual([false, true, true, false]);
    // The focus four are known without the store; another taxon reads the store, and one not loaded is null.
    expect([1, 2, 3, 4].map((id) => taxonCategory({}, id))).toEqual(["snakes", "lizards", "lizards", "fish"]);
    expect(taxonCategory({}, 99)).toBeNull();
    expect(taxonCategory({ "99": taxon(99, "x", "plants") }, 99)).toBe("plants");
    // GraphQL ids come as strings; a null ancestry falls back to the iconic group.
    expect(categoryOfTaxon({ ancestorIds: ["48460", "1", String(CATEGORY_ANCESTORS.birds)], iconicGroup: null })).toBe("birds");
    expect(categoryOfTaxon({ ancestorIds: null, iconicGroup: "Insecta" })).toBe("insects");
    expect(categoryOfTaxon(null)).toBe("other");
  });

  test("ensureTaxa asks once per unknown id, in batches, and fills the store with each taxon's category; the focus ids ride along", async () => {
    set<TaxaState>(TAXA, TAXA.defaults);
    const asked: string[][] = [];
    const request = async <T,>(_q: string, vars?: Record<string, unknown>): Promise<T> => {
      const ids = vars!.ids as string[];
      asked.push(ids);
      return {
        taxa: ids.map((id) => ({
          id,
          scientificName: `S${id}`,
          commonName: id === "7" ? "" : `Common ${id}`,
          focus: Number(id) <= 4,
          iconicGroup: id === "7" ? null : "Reptilia",
          ancestorIds: id === "7" ? null : ["48460", "1", String(CATEGORY_ANCESTORS.lizards)],
          summary: null,
          photoUrl: null,
          pageUrl: null,
        })),
      } as T;
    };
    const records = (ids: number[]): SightingRecord[] => ids.map((taxon) => ({ id: taxon, lon: -80.5, lat: 25.5, taxon, quality: 0, flags: 0 }));
    const sightings = { counts: Uint32Array.from([2, 1]), records: (f: number) => (f === 0 ? records([5, 7]) : records([5])) };
    expect(taxonIdsOf(sightings).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7]);
    await ensureTaxa(taxonIdsOf(sightings), request as typeof import("client/threads/api").gqlRequest);
    expect(asked).toEqual([["1", "2", "3", "4", "5", "7"]]);
    const byId = get<TaxaState>(TAXA)!.byId;
    expect(Object.keys(byId).sort()).toEqual(["1", "2", "3", "4", "5", "7"]);
    expect(byId["7"]).toMatchObject({ id: 7, commonName: "", iconicGroup: null, ancestorIds: null, category: "other" });
    expect(byId["5"]).toMatchObject({ category: "lizards", ancestorIds: [48460, 1, CATEGORY_ANCESTORS.lizards] });
    expect(get<TaxaState>(TAXA)!.version).toBe(1);
    // Nothing new: no request, no version bump. A new id: one more request for it alone.
    await ensureTaxa([5, 7], request as typeof import("client/threads/api").gqlRequest);
    expect(asked.length).toBe(1);
    await ensureTaxa([5, 9], request as typeof import("client/threads/api").gqlRequest);
    expect(asked[1]).toEqual(["9"]);
    expect(get<TaxaState>(TAXA)!.version).toBe(2);
    putTaxa([normalizeTaxon({ id: "9", scientificName: "S9", commonName: "Common 9", focus: false, iconicGroup: "Reptilia", ancestorIds: ["48460", "1", String(CATEGORY_ANCESTORS.lizards)], summary: null, photoUrl: null, pageUrl: null })]);
    expect(get<TaxaState>(TAXA)!.version).toBe(2);
    set<TaxaState>(TAXA, TAXA.defaults);
  });

  const taxa = {
    "10": taxon(10, "Brown Anole", "lizards", "The brown anole is a lizard. It is everywhere."),
    "11": taxon(11, "Cuban Tree Frog", "frogs"),
    "12": taxon(12, "Oleander", "plants"),
    "13": taxon(13, "Fire Ant", "insects"),
    "14": taxon(14, "Egyptian Goose", "birds"),
    "15": taxon(15, "Cane Toad", "frogs"),
    "16": taxon(16, "Muscovy Duck", "birds"),
    "17": taxon(17, "Rock Agama", "lizards"),
    "18": taxon(18, "House Gecko", "lizards"),
    "19": taxon(19, "", "snakes"),
    // A reptile with no ancestry stored (a GBIF row): the iconic group cannot split reptiles, so it is Other.
    "21": taxon(21, "Worm Lizard", null, null, "Reptilia"),
  };
  const breakdown = { "1": 0, "2": 0, "3": 5, "4": 0, "10": 40, "11": 20, "12": 300, "13": 9, "14": 8, "15": 7, "16": 6, "17": 5, "18": 4, "19": 3, "20": 2, "21": 1 };

  test("the bar's chips: focus pinned first even at 0, the most-seen animals next with their kind's icon and colour, then Other", () => {
    const chips = speciesChips(PYTHON_LAYERS.species, taxa, breakdown);
    expect(chips.map((c) => c.key)).toEqual(["python", "tegu", "iguana", "lionfish", "t10", "t11", "t14", "t15", "t16", "t17", "other"]);
    expect(TOP_ANIMAL_CHIPS).toBe(6);
    expect(chips.slice(0, 4).map((c) => c.count)).toEqual([0, 0, 5, 0]);
    expect(chips.slice(0, 4).map((c) => c.category)).toEqual(["snakes", "lizards", "lizards", "fish"]);
    expect(chips[4]).toMatchObject({ name: "Brown anole", line: "The brown anole is a lizard.", color: CATEGORY_COLORS.lizards, category: "lizards", on: true, count: 40, target: { kind: "taxon", id: 10 }, rank: 0 });
    expect(chips[5]).toMatchObject({ category: "frogs", color: CATEGORY_COLORS.frogs, line: "Genus species11, an introduced species" });
    expect(chips.map((c) => c.rank)).toEqual([undefined, undefined, undefined, undefined, 0, 1, 2, 3, 4, 5, undefined]);
    // Other: every non-focus sighting of the window (plants and insects included), opening the categories.
    expect(chips[10]).toMatchObject({ key: "other", name: "Other", target: { kind: "categories" }, category: "other", count: 405, on: true });
    expect(chips[0]!.color).toBe(SPECIES_COLORS[0]!);
    expect(colorOfTaxon(10, taxa)).toBe(CATEGORY_COLORS.lizards);
    expect(colorOfTaxon(20, taxa)).toBe(NEUTRAL_COLOR);
    // Filters show on the chips: a taxon override, a focus species off, every category off.
    const filtered = speciesChips({ ...PYTHON_LAYERS.species, iguana: false, t10: false }, taxa, breakdown);
    expect(filtered.find((c) => c.key === "iguana")!.on).toBe(false);
    expect(filtered.find((c) => c.key === "t10")!.on).toBe(false);
    const none = Object.fromEntries(CATEGORY_IDS.map((id) => [id, false]));
    expect(speciesChips({ ...PYTHON_LAYERS.species, ...none }, taxa, breakdown).find((c) => c.key === "other")!.on).toBe(false);
    // Before the globe reports: counts unknown, the four focus chips and Other still there.
    expect(speciesChips(PYTHON_LAYERS.species, taxa, null).map((c) => c.key)).toEqual(["python", "tegu", "iguana", "lionfish", "other"]);
    expect(speciesChips(PYTHON_LAYERS.species, taxa, null)[0]!.count).toBeNull();
    expect(firstSentence("One. Two.")).toBe("One.");
    expect(firstSentence("No end")).toBe("No end");
    expect(firstSentence(null)).toBeNull();
  });

  test("the categories popover: every category with its count, switch and most-seen species; unknown taxa and unsplit reptiles under Other", () => {
    const rows = categoryRows(PYTHON_LAYERS.species, taxa, breakdown);
    expect(rows.map((r) => r.id)).toEqual([...CATEGORY_IDS]);
    expect(TOP_CATEGORY_SPECIES).toBe(8);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.lizards).toMatchObject({ label: "Lizards", color: CATEGORY_COLORS.lizards, on: true, count: 49 });
    expect(by.lizards!.species.map((s) => [s.name, s.count, s.on])).toEqual([
      ["Brown anole", 40, true],
      ["Rock agama", 5, true],
      ["House gecko", 4, true],
    ]);
    expect(by.frogs).toMatchObject({ count: 27 });
    expect(by.birds!.species.map((s) => s.id)).toEqual([14, 16]);
    expect(by.snakes!.species[0]).toMatchObject({ name: "Genus species19", count: 3 });
    expect(by.plants).toMatchObject({ on: false, count: 300 });
    expect(by.insects).toMatchObject({ on: false, count: 9 });
    // 20 is not loaded, 21 has no ancestry: Other.
    expect(by.other).toMatchObject({ on: false, count: 3 });
    expect(by.other!.species.map((s) => s.name)).toEqual(["Species 20", "Worm lizard"]);
    expect(by.turtles).toMatchObject({ count: 0, species: [] });
    // Overrides and switches show per row.
    const filtered = categoryRows({ ...PYTHON_LAYERS.species, plants: true, t10: false }, taxa, breakdown);
    expect(filtered.find((r) => r.id === "plants")!.on).toBe(true);
    expect(filtered.find((r) => r.id === "lizards")!.species[0]!.on).toBe(false);
    expect(categoryRows(PYTHON_LAYERS.species, taxa, null).every((r) => r.count === null && r.species.length === 0)).toBe(true);
  });
});
