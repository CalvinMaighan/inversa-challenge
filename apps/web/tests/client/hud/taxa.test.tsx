import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { groupOf, isFocusTaxon, TAXA, taxonGroup, taxonName, type TaxaState, type TaxonInfo } from "client/state/taxa";
import { ensureTaxa, normalizeTaxon, putTaxa, taxonIdsOf } from "client/hud/taxa";
import { firstSentence, speciesChips, TOP_ANIMAL_CHIPS } from "client/hud/species/SpeciesBar";
import { LAYERS } from "client/state/layers";
import { colorOfTaxon, NEUTRAL_COLOR, SPECIES_COLORS } from "client/globe/species";
import { state } from "client/state";
import type { SightingRecord } from "shared/frames";

init(state);

const taxon = (id: number, commonName: string, iconicGroup: string | null, summary: string | null = null): TaxonInfo => ({
  id,
  scientificName: `Genus species${id}`,
  commonName,
  focus: id <= 4,
  iconicGroup,
  summary,
  photoUrl: null,
  pageUrl: `https://www.inaturalist.org/taxa/${id}`,
});

describe("taxa store (T44)", () => {
  test("names, groups and the focus ids", () => {
    expect(taxonName({ commonName: "Brown Anole", scientificName: "Anolis sagrei" })).toBe("Brown anole");
    expect(taxonName({ commonName: "", scientificName: "Anolis sagrei" })).toBe("Anolis sagrei");
    expect(taxonName({ commonName: "", scientificName: "" })).toBe("Unnamed species");
    expect(taxonName(null, "Species 9")).toBe("Species 9");
    expect(groupOf("Reptilia")).toBe("animals");
    expect(groupOf("Aves")).toBe("animals");
    expect(groupOf("Plantae")).toBe("plants");
    expect(groupOf("Fungi")).toBe("plants");
    expect(groupOf("Insecta")).toBe("others");
    expect(groupOf("other")).toBe("others");
    expect(groupOf(null)).toBe("others");
    expect([0, 1, 4, 5].map(isFocusTaxon)).toEqual([false, true, true, false]);
    // Unknown taxa draw as animals until loaded; the focus four are animals whatever the store says.
    expect(taxonGroup({}, 99)).toBe("animals");
    expect(taxonGroup({ "99": taxon(99, "x", "Plantae") }, 99)).toBe("plants");
    expect(taxonGroup({}, 2)).toBe("animals");
  });

  test("ensureTaxa asks once per unknown id, in batches, and fills the store; the focus ids ride along", async () => {
    set<TaxaState>(TAXA, TAXA.defaults);
    const asked: string[][] = [];
    const request = async <T,>(_q: string, vars?: Record<string, unknown>): Promise<T> => {
      const ids = vars!.ids as string[];
      asked.push(ids);
      return { taxa: ids.map((id) => ({ id, scientificName: `S${id}`, commonName: id === "7" ? "" : `Common ${id}`, focus: Number(id) <= 4, iconicGroup: id === "7" ? null : "Reptilia", summary: null, photoUrl: null, pageUrl: null })) } as T;
    };
    const records = (ids: number[]): SightingRecord[] => ids.map((taxon) => ({ id: taxon, lon: -80.5, lat: 25.5, taxon, quality: 0, flags: 0 }));
    const sightings = { counts: Uint32Array.from([2, 1]), records: (f: number) => (f === 0 ? records([5, 7]) : records([5])) };
    expect(taxonIdsOf(sightings).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7]);
    await ensureTaxa(taxonIdsOf(sightings), request as typeof import("client/threads/api").gqlRequest);
    expect(asked).toEqual([["1", "2", "3", "4", "5", "7"]]);
    const byId = get<TaxaState>(TAXA)!.byId;
    expect(Object.keys(byId).sort()).toEqual(["1", "2", "3", "4", "5", "7"]);
    expect(byId["7"]).toMatchObject({ id: 7, commonName: "", iconicGroup: null });
    expect(get<TaxaState>(TAXA)!.version).toBe(1);
    // Nothing new: no request, no version bump. A new id: one more request for it alone.
    await ensureTaxa([5, 7], request as typeof import("client/threads/api").gqlRequest);
    expect(asked.length).toBe(1);
    await ensureTaxa([5, 9], request as typeof import("client/threads/api").gqlRequest);
    expect(asked[1]).toEqual(["9"]);
    expect(get<TaxaState>(TAXA)!.version).toBe(2);
    putTaxa([normalizeTaxon({ id: "9", scientificName: "S9", commonName: "Common 9", focus: false, iconicGroup: "Reptilia", summary: null, photoUrl: null, pageUrl: null })]);
    expect(get<TaxaState>(TAXA)!.version).toBe(2);
    set<TaxaState>(TAXA, TAXA.defaults);
  });

  test("the bar's chips: focus pinned first even at 0, the most-seen animals next, then Plants and Insects & others off", () => {
    const taxa = {
      "10": taxon(10, "Brown Anole", "Reptilia", "The brown anole is a lizard. It is everywhere."),
      "11": taxon(11, "Cuban Tree Frog", "Amphibia"),
      "12": taxon(12, "Oleander", "Plantae"),
      "13": taxon(13, "Fire Ant", "Insecta"),
      "14": taxon(14, "Egyptian Goose", "Aves"),
      "15": taxon(15, "Cane Toad", "Amphibia"),
      "16": taxon(16, "Muscovy Duck", "Aves"),
      "17": taxon(17, "Rock Agama", "Reptilia"),
      "18": taxon(18, "House Gecko", "Reptilia"),
      "19": taxon(19, "", "Reptilia"),
    };
    const breakdown = { "1": 0, "2": 0, "3": 5, "4": 0, "10": 40, "11": 20, "12": 300, "13": 9, "14": 8, "15": 7, "16": 6, "17": 5, "18": 4, "19": 3, "20": 2 };
    const chips = speciesChips(LAYERS.defaults.species, taxa, breakdown);
    expect(chips.map((c) => c.key)).toEqual(["python", "tegu", "iguana", "lionfish", "t10", "t11", "t14", "t15", "t16", "t17", "plants", "others"]);
    expect(TOP_ANIMAL_CHIPS).toBe(6);
    expect(chips.slice(0, 4).map((c) => c.count)).toEqual([0, 0, 5, 0]);
    expect(chips[4]).toMatchObject({ name: "Brown anole", line: "The brown anole is a lizard.", color: colorOfTaxon(10), on: true, count: 40, target: { kind: "taxon", id: 10 } });
    expect(chips[5]!.line).toBe("Genus species11, an introduced species");
    // Group chips: totals over every taxon of the group (not only the chips), neutral while off. 20 is unknown: an animal.
    expect(chips.find((c) => c.key === "plants")).toMatchObject({ name: "Plants", count: 300, on: false, color: NEUTRAL_COLOR });
    expect(chips.find((c) => c.key === "others")).toMatchObject({ name: "Insects & others", count: 9, on: false });
    expect(chips[0]!.color).toBe(SPECIES_COLORS[0]!);
    // Filters show on the chips: a taxon override, a group switched on, a focus species off.
    const filtered = speciesChips({ ...LAYERS.defaults.species, iguana: false, plants: true, t10: false }, taxa, breakdown);
    expect(filtered.find((c) => c.key === "iguana")!.on).toBe(false);
    expect(filtered.find((c) => c.key === "t10")!.on).toBe(false);
    expect(filtered.find((c) => c.key === "plants")!.on).toBe(true);
    // Before the globe reports: counts unknown, the four focus chips and the groups still there.
    expect(speciesChips(LAYERS.defaults.species, taxa, null).map((c) => c.key)).toEqual(["python", "tegu", "iguana", "lionfish", "plants", "others"]);
    expect(speciesChips(LAYERS.defaults.species, taxa, null)[0]!.count).toBeNull();
    expect(firstSentence("One. Two.")).toBe("One.");
    expect(firstSentence("No end")).toBe("No end");
    expect(firstSentence(null)).toBeNull();
  });
});
