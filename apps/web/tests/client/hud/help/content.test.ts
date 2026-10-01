import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { EXAMPLE_QUESTIONS, HELP_ENTRIES, HELP_GROUPS } from "client/hud/help/content";

const README = readFileSync(path.resolve(import.meta.dir, "../../../../../../README.md"), "utf8");

describe("help sheet content", () => {
  test("lists every control on the page", () => {
    const ids = HELP_ENTRIES.map((e) => e.id);
    for (const id of ["feeds", "live", "focus", "theme", "help", "layers", "hover", "drawer", "share", "play", "step", "speed", "live-edge", "date", "scrub", "agent-tab", "missions-tab", "mic", "citations", "panels", "resize"]) {
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

  test("the first-visit hint offers the example questions", () => {
    expect(EXAMPLE_QUESTIONS).toContain("Iguana sightings near Homestead and water levels");
    expect(EXAMPLE_QUESTIONS).toContain("Where should python crews go tonight?");
  });

  test("README's UI section names every control the help sheet does", () => {
    const missing = HELP_ENTRIES.filter((e) => !README.includes(e.control)).map((e) => e.control);
    expect(missing).toEqual([]);
  });
});
