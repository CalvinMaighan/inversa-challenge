import { describe, expect, test } from "bun:test";

import { ANIMAL_CATEGORIES, CATEGORY_ANCESTORS, CATEGORY_COLORS, CATEGORY_DEFAULT_ON, CATEGORY_IDS, CATEGORY_LABELS, categoryFromAncestry, FOCUS_CATEGORIES } from "shared/species-categories";
import { CATEGORY_ICONS } from "shared/species-icons";
import { SPECIES_IDS } from "shared/voice/ui-tools";

/**
 * Ancestries shaped like iNat's `ancestor_ids` (root first: Life 48460, Animalia 1, Chordata 2, …). The deciding
 * ids are the verified category ancestors in CATEGORY_ANCESTORS; the ids around them only give each list its shape.
 */
const BROWN_ANOLE = [48460, 1, 2, 355675, 26036, 26172, 85552, 36231, 36229, 116461];
const BURMESE_PYTHON = [48460, 1, 2, 355675, 26036, 26172, 85553, 85555, 32166, 32165, 35342];
const CUBAN_TREE_FROG = [48460, 1, 2, 355675, 20978, 20979, 20982, 24405, 24398];
const EGYPTIAN_GOOSE = [48460, 1, 2, 355675, 3, 67561, 6888, 7034, 7035];
const RED_EARED_SLIDER = [48460, 1, 2, 355675, 26036, 39532, 39533, 39534, 39682];
const LIONFISH = [48460, 1, 2, 355675, 47178, 49571, 49572, 49573, 47284];
const GIANT_AFRICAN_SNAIL = [48460, 47115, 47114, 47113, 47112, 47111, 47110];
const FIRE_ANT = [48460, 1, 47120, 372739, 47158, 184884, 47201, 47208, 57855];
const SPINY_ORB_WEAVER = [48460, 1, 47120, 245097, 47119, 47118, 47117, 47116];
const BRAZILIAN_PEPPER = [48460, 47126, 211194, 47125, 47124, 47123, 47122, 47121];
const NILE_MONITOR = [48460, 1, 2, 355675, 26036, 26172, 85552, 36002, 36003, 36007];
const SPECTACLED_CAIMAN = [48460, 1, 2, 355675, 26036, 26039, 26040, 26041, 26042];
const AXOLOTL = [48460, 1, 2, 355675, 20978, 26718, 26719, 26720, 26721];

describe("species categories (T44)", () => {
  test("category from ancestry", () => {
    expect(categoryFromAncestry(BROWN_ANOLE)).toBe("lizards");
    expect(categoryFromAncestry(NILE_MONITOR)).toBe("lizards");
    expect(categoryFromAncestry(BURMESE_PYTHON)).toBe("snakes");
    expect(categoryFromAncestry(RED_EARED_SLIDER)).toBe("turtles");
    expect(categoryFromAncestry(SPECTACLED_CAIMAN)).toBe("crocodilians");
    expect(categoryFromAncestry(CUBAN_TREE_FROG)).toBe("frogs");
    expect(categoryFromAncestry(EGYPTIAN_GOOSE)).toBe("birds");
    expect(categoryFromAncestry(LIONFISH)).toBe("fish");
    expect(categoryFromAncestry(GIANT_AFRICAN_SNAIL)).toBe("snails");
    expect(categoryFromAncestry(FIRE_ANT)).toBe("insects");
    expect(categoryFromAncestry(SPINY_ORB_WEAVER)).toBe("spiders");
    expect(categoryFromAncestry(BRAZILIAN_PEPPER)).toBe("plants");
    // A salamander is an amphibian but not a frog: other.
    expect(categoryFromAncestry(AXOLOTL)).toBe("other");
    // No ancestry (a GBIF or NAS taxon): the iconic group decides where it can; reptiles cannot be split.
    expect(categoryFromAncestry(null, "Aves")).toBe("birds");
    expect(categoryFromAncestry([], "Plantae")).toBe("plants");
    expect(categoryFromAncestry(undefined, "Fungi")).toBe("plants");
    expect(categoryFromAncestry(undefined, "Reptilia")).toBe("other");
    expect(categoryFromAncestry(undefined, null)).toBe("other");
    // Ancestry wins over the iconic group.
    expect(categoryFromAncestry(BURMESE_PYTHON, "Aves")).toBe("snakes");
  });

  test("every category has a label, a noun, a colour, an icon and a default; the ancestors are the verified iNat ids", () => {
    for (const id of CATEGORY_IDS) {
      expect(CATEGORY_LABELS[id].length).toBeGreaterThan(2);
      expect(CATEGORY_COLORS[id]).toMatch(/^#[0-9a-f]{6}$/);
      expect(typeof CATEGORY_DEFAULT_ON[id]).toBe("boolean");
      expect(CATEGORY_ICONS[id].paths.length + (CATEGORY_ICONS[id].circles?.length ?? 0)).toBeGreaterThan(0);
      expect(CATEGORY_ICONS[id].source).toMatch(/^(lucide|custom)/);
    }
    expect(new Set(Object.values(CATEGORY_COLORS)).size).toBe(CATEGORY_IDS.length);
    expect(CATEGORY_ANCESTORS).toEqual({ snakes: 85553, lizards: 85552, turtles: 39532, crocodilians: 26039, frogs: 20979, birds: 3, mammals: 40151, fish: 47178, snails: 47114, insects: 47158, spiders: 47119, plants: 47126 });
    expect(ANIMAL_CATEGORIES.every((id) => CATEGORY_DEFAULT_ON[id])).toBe(true);
    expect(["insects", "spiders", "plants", "other"].every((id) => !CATEGORY_DEFAULT_ON[id as "other"])).toBe(true);
    expect(FOCUS_CATEGORIES).toEqual(["snakes", "lizards", "lizards", "fish"]);
    expect(FOCUS_CATEGORIES.length).toBe(SPECIES_IDS.length);
  });
});
