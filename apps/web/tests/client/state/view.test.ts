import { describe, expect, test } from "bun:test";

import { altitudeToFit, VIEW, viewFor } from "client/state/view";
import { appBBox, getApp } from "shared/apps";

const SOUTH_FLORIDA = { west: -83.2, south: 24.3, east: -79.8, north: 27.5 };

describe("VIEW", () => {
  test("python's preset is the C15 region, looked at from its camera", () => {
    const v = viewFor(getApp("python"));
    expect(v.bbox).toEqual(SOUTH_FLORIDA);
    expect(v.lat).toBeCloseTo(25.9, 10);
    expect(v.lon).toBeCloseTo(-81.5, 10);
    expect(v.heading).toBe(0);
    expect(v.pitch).toBe(-90);
    expect(v.altitudeM).toBe(getApp("python").regions[0]!.camera.heightM);
    // Fly-command fields (voice fly_to): no named target yet, nothing flown.
    expect(v.place).toBeNull();
    expect(v.seq).toBe(0);
    expect(viewFor(getApp("python"), 7).seq).toBe(7);
  });

  test("defaults are the default app's (carp) preset", () => {
    expect(VIEW.defaults).toEqual(viewFor(getApp("carp")));
    expect(VIEW.defaults.lat).toBe(getApp("carp").regions[0]!.camera.lat);
    expect(VIEW.defaults.lon).toBe(getApp("carp").regions[0]!.camera.lon);
  });

  test("an app with several regions frames all of them from their centre", () => {
    const lionfish = getApp("lionfish");
    const v = viewFor(lionfish);
    const b = appBBox(lionfish);
    expect(v.bbox).toEqual(b);
    expect(v.lat).toBeCloseTo((b.south + b.north) / 2, 10);
    expect(v.lon).toBeCloseTo((b.west + b.east) / 2, 10);
    expect(v.altitudeM).toBe(altitudeToFit(b));
  });

  test("altitudeToFit frames the larger side of the box", () => {
    // 3.2° of latitude ≈ 356 km is the larger side here; half of it over tan(30°), plus 10 %.
    const expected = ((3.2 * 111_320) / 2 / Math.tan(Math.PI / 6)) * 1.1;
    expect(altitudeToFit(SOUTH_FLORIDA)).toBe(Math.round(expected));
    const wide = { west: -90, south: 25, east: -80, north: 26 };
    expect(altitudeToFit(wide)).toBeGreaterThan(altitudeToFit(SOUTH_FLORIDA));
  });
});
