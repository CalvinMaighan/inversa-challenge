/**
 * Species categories (T44): what a sighting is, in words a newcomer uses, from the taxon's iNaturalist ancestry.
 * The globe draws each category's icon in its colour; the species bar's "Other" chip opens them as a list.
 *
 * Mapping is by iNat ancestor taxon ids, each checked against `GET https://api.inaturalist.org/v1/taxa/<id>` on
 * 2026-10-01: Serpentes 85553 (suborder, snakes), Sauria 85552 (suborder, lizards; iNat's own split of Squamata
 * 26172, so no "Squamata minus Serpentes" is needed), Testudines 39532, Crocodylia 26039, Anura 20979 (frogs and
 * toads), Aves 3, Mammalia 40151, Actinopterygii 47178, Gastropoda 47114 (snails and slugs), Insecta 47158,
 * Arachnida 47119, Plantae 47126. A taxon with no ancestry stored (GBIF or NAS only) falls back to its iconic
 * group; anything else is `other`.
 */

export const CATEGORY_IDS = ["snakes", "lizards", "turtles", "crocodilians", "frogs", "birds", "mammals", "fish", "snails", "insects", "spiders", "plants", "other"] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  snakes: "Snakes",
  lizards: "Lizards",
  turtles: "Turtles & tortoises",
  crocodilians: "Crocodilians",
  frogs: "Frogs & toads",
  birds: "Birds",
  mammals: "Mammals",
  fish: "Fish",
  snails: "Snails & slugs",
  insects: "Insects",
  spiders: "Spiders",
  plants: "Plants",
  other: "Other",
};

/** One plain noun per category, for "introduced lizard" on a card. */
export const CATEGORY_NOUNS: Record<CategoryId, string> = {
  snakes: "snake",
  lizards: "lizard",
  turtles: "turtle",
  crocodilians: "crocodilian",
  frogs: "frog or toad",
  birds: "bird",
  mammals: "mammal",
  fish: "fish",
  snails: "snail",
  insects: "insect",
  spiders: "spider",
  plants: "plant",
  other: "species",
};

/** iNat ancestor taxon id that puts a taxon in each category (verified ids, see the module note). */
export const CATEGORY_ANCESTORS: Record<Exclude<CategoryId, "other">, number> = {
  snakes: 85553,
  lizards: 85552,
  turtles: 39532,
  crocodilians: 26039,
  frogs: 20979,
  birds: 3,
  mammals: 40151,
  fish: 47178,
  snails: 47114,
  insects: 47158,
  spiders: 47119,
  plants: 47126,
};

/** Fallback by iNat iconic group when a taxon carries no ancestry (reptiles cannot be split without it). */
const ICONIC_CATEGORY: Record<string, CategoryId> = {
  Aves: "birds",
  Mammalia: "mammals",
  Actinopterygii: "fish",
  Mollusca: "snails",
  Insecta: "insects",
  Arachnida: "spiders",
  Plantae: "plants",
  Fungi: "plants",
  Amphibia: "frogs",
};

/** The category of a taxon from its iNat `ancestor_ids`, else its iconic group, else `other`. */
export function categoryFromAncestry(ancestorIds: readonly number[] | null | undefined, iconicGroup?: string | null): CategoryId {
  if (ancestorIds && ancestorIds.length > 0) {
    const ids = new Set(ancestorIds);
    for (const id of CATEGORY_IDS) {
      if (id !== "other" && ids.has(CATEGORY_ANCESTORS[id])) return id;
    }
  }
  return (iconicGroup && ICONIC_CATEGORY[iconicGroup]) || "other";
}

/** Categories drawn by default: every animal. Insects, spiders, plants and the rest wait behind their switches. */
export const CATEGORY_DEFAULT_ON: Record<CategoryId, boolean> = {
  snakes: true,
  lizards: true,
  turtles: true,
  crocodilians: true,
  frogs: true,
  birds: true,
  mammals: true,
  fish: true,
  snails: true,
  insects: false,
  spiders: false,
  plants: false,
  other: false,
};

/** The categories that count as "animals" for the bar's chips and the agent's `species_counts`. */
export const ANIMAL_CATEGORIES: readonly CategoryId[] = ["snakes", "lizards", "turtles", "crocodilians", "frogs", "birds", "mammals", "fish", "snails"];

/**
 * Label colours, one per category, apart from each other, from the four focus colours (amber, orange, green,
 * pink) and from the heat ramp's violet-to-yellow run. Hex, because Cesium parses no oklch().
 */
export const CATEGORY_COLORS: Record<CategoryId, string> = {
  snakes: "#f4d35e",
  lizards: "#2ec4b6",
  turtles: "#8ac926",
  crocodilians: "#4fb3ff",
  frogs: "#06d6a0",
  birds: "#c678dd",
  mammals: "#ff9f1c",
  fish: "#7f7fff",
  snails: "#ef476f",
  insects: "#b5de2b",
  spiders: "#ff85a1",
  plants: "#3bceac",
  other: "#b8c0cc",
};

/** The focus species' categories, in SPECIES_IDS order (python, tegu, iguana, lionfish). */
export const FOCUS_CATEGORIES: readonly CategoryId[] = ["snakes", "lizards", "lizards", "fish"];
