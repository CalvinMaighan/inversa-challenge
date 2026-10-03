import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { GLASS_CSS, POPOVER_BUTTONS_CSS } from "client/hud/primitives";
import { PALETTES, THEME_MODES } from "client/themes/palette";

/** Every popover, dialog and tooltip of the HUD, by file. */
const POPOVERS = [
  "client/hud/topbar/TopBar.tsx",
  "client/hud/look/LookBar.tsx",
  "client/hud/search/PlaceSearch.tsx",
  "client/hud/developer/DeveloperPanel.tsx",
  "client/hud/help/HelpSheet.tsx",
  "client/hud/tooltip/GlobeTooltip.tsx",
  "client/hud/species/SpeciesBar.tsx",
  "client/hud/timeline/Timeline.tsx",
];

describe("popover glass", () => {
  test("the shared glass is the HUD surface: 82% surface, 10px blur with saturation, the theme shadow", () => {
    expect(GLASS_CSS).toContain("color-mix(in oklch, var(--surface) 82%, transparent)");
    expect(GLASS_CSS).toContain("backdrop-filter: blur(10px) saturate(1.2)");
    expect(GLASS_CSS).toContain("-webkit-backdrop-filter: blur(10px) saturate(1.2)");
    expect(GLASS_CSS).toContain("box-shadow: var(--shadow)");
  });

  test("every popover, dialog and tooltip uses it, and none paints a solid surface of its own", () => {
    for (const file of POPOVERS) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("${GLASS_CSS}");
    }
  });

  test("the popovers' buttons carry --shadow-button", () => {
    expect(POPOVER_BUTTONS_CSS).toContain("var(--shadow-button)");
    for (const file of ["client/hud/topbar/TopBar.tsx", "client/hud/look/LookBar.tsx", "client/hud/search/PlaceSearch.tsx", "client/hud/developer/DeveloperPanel.tsx", "client/hud/help/HelpSheet.tsx"]) {
      expect(readFileSync(file, "utf8"), file).toContain("${POPOVER_BUTTONS_CSS}");
    }
  });

  test("--shadow-button is defined in every theme", () => {
    for (const mode of THEME_MODES) expect(PALETTES[mode].colors["shadow-button"]).toMatch(/rgb|oklch/);
  });
});
