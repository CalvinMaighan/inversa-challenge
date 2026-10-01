import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ABOUT_SENTENCE, EXAMPLE_QUESTIONS, HELP_ENTRIES, HELP_GROUPS, SPECIES_GUIDE, WELCOME } from "client/hud/help/content";
import { SPECIES_FILTER_IDS } from "client/state/layers";

const README = readFileSync(path.resolve(import.meta.dir, "../../../../../../README.md"), "utf8");

describe("help sheet content", () => {
  test("lists every control on the page", () => {
    const ids = HELP_ENTRIES.map((e) => e.id);
    for (const id of ["species", "dots", "drawer", "about", "feeds", "layers", "focus", "theme", "help", "share", "play", "speed", "live", "date", "scrub", "agent-tab", "missions-tab", "mic", "citations", "panels", "resize"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry has a known group, a control name and a description", () => {
    for (const e of HELP_ENTRIES) {
      expect(HELP_GROUPS).toContain(e.group);
      expect(e.control.trim().length).toBeGreaterThan(0);
      expect(e.what.trim().length).toBeGreaterThan(10);
    }
    for (const g of HELP_GROUPS) expect(HELP_ENTRIES.some((e) => e.group === g)).toBe(true);
  });

  test("the first-visit welcome: two plain sentences, a line per species chip, and example questions", () => {
    expect(WELCOME.split(/(?<=[.;!?])\s+(?=[A-Z])/).filter(Boolean).length).toBeLessThanOrEqual(2);
    expect(WELCOME).toContain("last 48 hours");
    expect(SPECIES_GUIDE.map((s) => s.id)).toEqual([...SPECIES_FILTER_IDS]);
    for (const s of SPECIES_GUIDE) expect(s.line.length).toBeGreaterThan(10);
    expect(SPECIES_GUIDE[0]).toMatchObject({ full: "Burmese python", line: "giant constrictor eating Everglades wildlife" });
    expect(ABOUT_SENTENCE.split(". ").length).toBe(1);
    expect(EXAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(2);
    expect(EXAMPLE_QUESTIONS.length).toBeLessThanOrEqual(3);
    expect(EXAMPLE_QUESTIONS).toContain("Iguana sightings near Homestead and water levels");
    expect(EXAMPLE_QUESTIONS).toContain("Where should python crews go tonight?");
  });

  test("README's UI section names every control the help sheet does", () => {
    const missing = HELP_ENTRIES.filter((e) => !README.includes(e.control)).map((e) => e.control);
    expect(missing).toEqual([]);
  });
});
