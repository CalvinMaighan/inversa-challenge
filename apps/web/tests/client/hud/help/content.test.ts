import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { aboutSentence, exampleQuestions, HELP_ENTRIES, HELP_GROUPS, speciesGuide, welcome, WINDOW_NOTE } from "client/hud/help/content";
import { APP_IDS, getApp, speciesIds } from "shared/apps";

const PYTHON = getApp("python");
const WELCOME = welcome(PYTHON);
const SPECIES_GUIDE = speciesGuide(PYTHON);
const EXAMPLE_QUESTIONS = exampleQuestions(PYTHON);

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
    expect(WELCOME).toContain("last 7 days");
    expect(WINDOW_NOTE).toBe("Most people upload sightings a few days after they see them, so the last 7 days shows the most.");
    expect(SPECIES_GUIDE.map((s) => s.id)).toEqual([...speciesIds(PYTHON), "other"]);
    for (const s of SPECIES_GUIDE) expect(s.line.length).toBeGreaterThan(10);
    expect(SPECIES_GUIDE[0]).toMatchObject({ full: "Burmese python", line: "giant constrictor eating Everglades wildlife" });
    for (const id of APP_IDS) expect(aboutSentence(getApp(id)).split(". ").length).toBeLessThanOrEqual(2);
    expect(EXAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(2);
    expect(EXAMPLE_QUESTIONS.length).toBeLessThanOrEqual(3);
    expect(EXAMPLE_QUESTIONS).toEqual(PYTHON.helperQuestions.slice(0, 3));
  });

  test("active app: welcome, species guide, helper questions and About line are the app's", () => {
    const carp = getApp("carp");
    expect(welcome(carp)).toContain("Louisiana demonstration locations");
    expect(welcome(carp)).not.toContain("invasive animal");
    expect(speciesGuide(carp).map((s) => s.id)).toEqual(["other"]);
    expect(exampleQuestions(carp)).toEqual(carp.helperQuestions.slice(0, 3));
    expect(aboutSentence(carp)).toContain("cannot tell carp abundance");
    const lionfish = getApp("lionfish");
    expect(speciesGuide(lionfish).map((s) => s.id)).toEqual(["lionfish", "other"]);
    expect(welcome(lionfish)).toContain("last 30 days");
    for (const id of APP_IDS) expect(new Set(exampleQuestions(getApp(id))).size).toBe(Math.min(3, getApp(id).helperQuestions.length));
  });

  test("README's UI section names every control the help sheet does", () => {
    const missing = HELP_ENTRIES.filter((e) => !README.includes(e.control)).map((e) => e.control);
    expect(missing).toEqual([]);
  });
});
