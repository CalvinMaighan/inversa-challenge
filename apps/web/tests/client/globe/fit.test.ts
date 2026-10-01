import { describe, expect, test } from "bun:test";

import { boxOf, fitBBox, freeRect } from "client/globe/fit";

const pane = { left: 0, top: 0, right: 375, bottom: 740 };

describe("free rect of the globe pane", () => {
  test("bars cut the top and bottom, a tall panel its side", () => {
    const f = freeRect({ left: 0, top: 0, right: 1000, bottom: 900 }, [
      { left: 0, top: 0, right: 1000, bottom: 50 },
      { left: 10, top: 700, right: 990, bottom: 890 },
      { left: 10, top: 60, right: 350, bottom: 690 },
    ]);
    expect(f).toEqual({ left: 350, top: 50, right: 1000, bottom: 700 });
  });

  test("a small tab above the timeline cuts the bottom, not the side (most area kept)", () => {
    const f = freeRect(pane, [
      { left: 8, top: 600, right: 367, bottom: 732 },
      { left: 12, top: 554, right: 93, bottom: 584 },
    ]);
    expect(f).toEqual({ left: 0, top: 0, right: 375, bottom: 554 });
  });

  test("obstacles outside the pane are ignored", () => {
    expect(freeRect(pane, [{ left: 400, top: 0, right: 500, bottom: 100 }])).toEqual({ left: 0, top: 0, right: 375, bottom: 740 });
  });
});

describe("fitting a box in the free rect", () => {
  const box = { west: -92.5, south: 29.5, east: -91, north: 32.5 };

  test("free rect centred on the pane: the camera sits over the box's centre", () => {
    const p = fitBBox(box, 375, 740, { left: 0, top: 0, right: 375, bottom: 740 });
    expect(p.lat).toBeCloseTo(31, 6);
    expect(p.lon).toBeCloseTo(-91.75, 6);
    expect(p.pitch).toBe(-90);
  });

  test("free rect in the upper part: the camera moves south so the box lands higher on screen", () => {
    const top = fitBBox(box, 375, 740, { left: 0, top: 0, right: 375, bottom: 400 });
    expect(top.lat).toBeLessThan(31);
    // A smaller rect needs a higher camera.
    expect(top.altitudeM).toBeGreaterThan(fitBBox(box, 375, 740, { left: 0, top: 0, right: 375, bottom: 740 }).altitudeM);
  });

  test("free rect on the right: the camera moves west", () => {
    expect(fitBBox(box, 1000, 900, { left: 350, top: 0, right: 1000, bottom: 900 }).lon).toBeLessThan(-91.75);
  });

  test("boxOf spans the points", () => {
    expect(boxOf([{ lat: 30, lon: -91 }, { lat: 32, lon: -92 }])).toEqual({ west: -92, south: 30, east: -91, north: 32 });
  });
});
