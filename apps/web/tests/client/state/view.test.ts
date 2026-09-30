import { describe, expect, test } from "bun:test";

import { altitudeToFit, REGION_BBOX, VIEW } from "client/state/view";

describe("VIEW", () => {
  test("region bbox is PLAN.md C15", () => {
    expect(REGION_BBOX).toEqual({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 });
    expect(Object.isFrozen(REGION_BBOX)).toBe(true);
  });

  test("defaults look straight down at the centre of the region", () => {
    const v = VIEW.defaults;
    expect(v.bbox).toEqual({ ...REGION_BBOX });
    expect(v.bbox).not.toBe(REGION_BBOX);
    expect(v.lat).toBeCloseTo(25.9, 10);
    expect(v.lon).toBeCloseTo(-81.5, 10);
    expect(v.heading).toBe(0);
    expect(v.pitch).toBe(-90);
    expect(v.altitudeM).toBe(altitudeToFit(REGION_BBOX));
  });

  test("altitudeToFit frames the larger side of the box", () => {
    // 3.2° of latitude ≈ 356 km is the larger side here; half of it over tan(30°), plus 10 %.
    const expected = ((3.2 * 111_320) / 2 / Math.tan(Math.PI / 6)) * 1.1;
    expect(altitudeToFit(REGION_BBOX)).toBe(Math.round(expected));
    const wide = { west: -90, south: 25, east: -80, north: 26 };
    expect(altitudeToFit(wide)).toBeGreaterThan(altitudeToFit(REGION_BBOX));
  });
});
