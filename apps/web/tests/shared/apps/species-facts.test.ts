import { describe, expect, test } from "bun:test";

import { APP_IDS } from "shared/apps";
import { FACT_TOPICS, SOURCES, SPECIES_FACTS, speciesFactsFor, TOPIC_WORDS } from "shared/apps/species-facts";

describe("species facts", () => {
  test("every app has its species, with the questions a hunter asks covered: look, size, diet, habitat, hunting, rules, safety, report", () => {
    for (const id of APP_IDS) {
      const { species, sources } = speciesFactsFor(id);
      expect(species.length).toBeGreaterThan(0);
      expect(sources.length).toBeGreaterThanOrEqual(2);
      const topics = new Set(species.flatMap((s) => s.facts.map((f) => f.topic)));
      for (const t of ["look", "hunting", "rules", "report"] as const) expect([id, t, topics.has(t)]).toEqual([id, t, true]);
    }
  });

  test("a species app has its one species; carp has the four and a shared entry", () => {
    expect(speciesFactsFor("python").species.map((s) => s.name)).toEqual(["Burmese python"]);
    expect(speciesFactsFor("lionfish").species.map((s) => s.name)).toEqual(["Lionfish"]);
    expect(speciesFactsFor("carp").species.map((s) => s.name)).toEqual(["Asian carp (all four)", "Silver carp", "Bighead carp", "Grass carp", "Black carp"]);
    // "Asian carp" with a topic only the four species carry still answers (the voice asked for "look" of "Asian carp" and got nothing).
    expect(speciesFactsFor("carp", { species: "Asian carp", topic: "look" }).species.length).toBeGreaterThan(0);
    expect(speciesFactsFor("carp", { species: "carp", topic: "diet" }).species.length).toBeGreaterThan(0);
  });

  test("a species and a topic narrow the answer; a name the app does not know gives everything", () => {
    const silver = speciesFactsFor("carp", { species: "silver", topic: "diet" });
    expect(silver.species.map((s) => s.name)).toEqual(["Silver carp"]);
    expect(silver.species[0]!.facts.map((f) => f.topic)).toEqual(["diet"]);
    expect(silver.species[0]!.facts[0]!.text).toMatch(/filter feeder/);
    expect(speciesFactsFor("carp", { species: "grass carp", topic: "look" }).species.map((s) => s.name)).toEqual(["Grass carp"]);
    expect(speciesFactsFor("carp", { species: "narwhal" }).species).toHaveLength(5);
    expect(speciesFactsFor("python", { topic: "rules" }).species[0]!.facts).toHaveLength(1);
    // The all-carp facts (telling the four apart, the rules) come along when a topic is asked about one carp.
    const id = speciesFactsFor("carp", { species: "silver", topic: "identify" }).species;
    expect(id.map((s) => s.name)).toEqual(["Asian carp (all four)", "Silver carp"]);
    expect(id[0]!.facts[0]!.text).toMatch(/throat to the anus[\s\S]*pelvic fins to the anus/);
  });

  test("every topic has its words, every fact a topic, a title and plain text, and every source an https link", () => {
    for (const t of FACT_TOPICS) expect(TOPIC_WORDS[t].length).toBeGreaterThan(3);
    for (const id of APP_IDS) {
      for (const s of SPECIES_FACTS[id].species) {
        for (const f of s.facts) {
          expect(FACT_TOPICS as readonly string[]).toContain(f.topic);
          expect(f.title.length).toBeGreaterThan(3);
          expect(f.text.length).toBeGreaterThan(40);
        }
      }
      for (const key of SPECIES_FACTS[id].sources) expect(new URL(SOURCES[key]!.url).protocol).toBe("https:");
    }
  });

  test("rules and safety say they change or give a way to check, and nothing states a licence as certain", () => {
    for (const id of APP_IDS) {
      for (const s of SPECIES_FACTS[id].species) {
        for (const f of s.facts.filter((x) => x.topic === "rules")) expect(f.text).toMatch(/Rules change|check|confirm/i);
      }
    }
  });
});
