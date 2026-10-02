import { describe, expect, test } from "bun:test";
import { PYTHON_LAYERS, SPECIES_COLORS, selectPython } from "@/tests/client/python-app";
import { renderToStaticMarkup } from "react-dom/server";

import AppIcon from "client/hud/appselect/AppIcon";
import { speciesChip } from "client/hud/species/model";
import { applyApp } from "client/state/app-switch";
import { layersFor } from "client/state/layers";
import { APP_ICONS } from "shared/app-icons";
import { getApp } from "shared/apps";

selectPython();

describe("species chip", () => {
  test("the app's one species: name, line, colour, the app icon, its switch and its count (taxon 1 of the breakdown)", () => {
    const chip = speciesChip(PYTHON_LAYERS.species, { "1": 12 })!;
    expect(chip).toEqual({ key: "python", name: "Python", full: "Burmese python", line: getApp("python").taxa[0]!.line!, color: SPECIES_COLORS[0]!, icon: "python", on: true, count: 12 });
    // Off when the filter hides it; 0 when the window holds none; unknown before the globe reports.
    expect(speciesChip({ ...PYTHON_LAYERS.species, python: false }, { "1": 12 })!.on).toBe(false);
    expect(speciesChip(PYTHON_LAYERS.species, {})!.count).toBe(0);
    expect(speciesChip(PYTHON_LAYERS.species, null)!.count).toBeNull();
  });

  test("lionfish has its one chip; carp (conditions, no species) has none", () => {
    applyApp("lionfish");
    try {
      expect(speciesChip(layersFor(getApp("lionfish")).species, { "1": 3 })).toMatchObject({ key: "lionfish", icon: "lionfish", on: true, count: 3 });
      applyApp("carp");
      expect(speciesChip(layersFor(getApp("carp")).species, null)).toBeNull();
    } finally {
      selectPython();
    }
  });

  test("the app icon draws the shared shape, outlined, in the given colour", () => {
    const svg = renderToStaticMarkup(<AppIcon icon="python" color="#e4572e" size={18} />);
    expect(svg).toContain('data-app-icon="python"');
    expect(svg).toContain('width="18"');
    expect(svg).toContain('aria-hidden="true"');
    for (const d of APP_ICONS.python.paths) expect(svg).toContain(`d="${d}"`);
    // Outline first, then the tint.
    expect(svg.indexOf('stroke="#0b0d12"')).toBeLessThan(svg.indexOf('stroke="#e4572e"'));
    // The fish apps use their colour emoji images (Noto Emoji via Iconify): carp the fish, lionfish the blowfish.
    expect(renderToStaticMarkup(<AppIcon icon="carp" color="#7f7fff" title="Carp" />)).toContain('src="/icons/noto-fish.svg"');
    expect(renderToStaticMarkup(<AppIcon icon="lionfish" color="#a06cd5" />)).toContain('src="/icons/noto-blowfish.svg"');
  });
});
