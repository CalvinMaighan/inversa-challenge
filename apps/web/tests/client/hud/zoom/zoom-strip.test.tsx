import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { PLACE_SCALES, placeScale } from "client/globe/zoom/model";
import { SCALE_ICON_IDS, ScaleIcon } from "client/hud/zoom/scale-icons";
import { STRIP_HEIGHT_PX, STRIP_INLINE_QUERY, STRIP_WIDTH_CSS, TIMELINE_RIGHT_WITH_STRIP_CSS, TIMELINE_STRIP_ROOM } from "client/hud/zoom/strip";

const CLIENT = path.resolve(import.meta.dir, "../../../../client");

describe("zoom strip", () => {
  test("zoom strip: one Lucide icon per place scale, in order from the whole planet to a street, each different", () => {
    const names = PLACE_SCALES.map((s) => s.name);
    expect(names).toEqual(["World", "Country", "State or region", "County", "City", "Neighbourhood", "Street"]);
    expect(Object.keys(SCALE_ICON_IDS).sort()).toEqual([...names].sort());
    expect(names.map((n) => SCALE_ICON_IDS[n])).toEqual(["globe", "flag", "map", "map-pinned", "building-2", "house", "route"]);
    const drawn = names.map((n) => renderToStaticMarkup(<ScaleIcon scale={n} />));
    expect(new Set(drawn).size).toBe(7);
    for (const [i, svg] of drawn.entries()) {
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain(`data-scale-icon="${SCALE_ICON_IDS[names[i]!]}"`);
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toMatch(/<(path|circle)/);
    }
  });

  test("zoom strip: the scale an altitude falls in is one of the seven icons' names (so the right one is lit)", () => {
    for (const altitude of [30, 900, 5_000, 40_000, 500_000, 3_000_000, 15_000_000]) expect(Object.keys(SCALE_ICON_IDS)).toContain(placeScale(altitude));
  });

  test("zoom strip: sits in the timeline's row at its right end: the timeline gives up the strip's width plus one gap", () => {
    expect(STRIP_WIDTH_CSS).toBe("clamp(212px, 34cqw, 320px)");
    expect(STRIP_HEIGHT_PX).toBeLessThanOrEqual(82);
    expect(STRIP_INLINE_QUERY).toBe("@container globe (min-width: 560px)");
    expect(TIMELINE_RIGHT_WITH_STRIP_CSS).toBe("calc(max(var(--gap-m), env(safe-area-inset-right)) + clamp(212px, 34cqw, 320px) + var(--gap-m))");
    // Only on the stage layout, and only where the HUD has room: a phone keeps the pair, a narrow HUD puts the strip above.
    expect(TIMELINE_STRIP_ROOM).toContain("@media (min-width: 768px)");
    expect(TIMELINE_STRIP_ROOM).toContain(STRIP_INLINE_QUERY);
    expect(TIMELINE_STRIP_ROOM).toContain(TIMELINE_RIGHT_WITH_STRIP_CSS);
  });

  test("zoom strip: both timelines (sightings and carp's stage timeline) leave room for it", () => {
    for (const file of ["hud/timeline/Timeline.tsx", "carp/CarpTimeline.tsx"]) {
      expect(readFileSync(path.join(CLIENT, file), "utf8")).toContain("${TIMELINE_STRIP_ROOM}");
    }
  });

  test("zoom strip: the old floating column and its placement logic are gone", () => {
    const source = readFileSync(path.join(CLIENT, "hud/zoom/ZoomControls.tsx"), "utf8");
    expect(source).not.toContain("placeColumn");
    expect(source).not.toContain("--zoom-right");
    expect(source).not.toContain("TAB_ROOM_PX");
    // The words are gone from the scale: only the icons (with names for assistive technology and tooltips).
    expect(source).not.toMatch(/<Label\b/);
  });
});
