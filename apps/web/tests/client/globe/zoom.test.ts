import { describe, expect, test } from "bun:test";

import { rightmostSlot } from "client/hud/zoom/place";

import {
  altitudeToSlider,
  altitudeValueText,
  autoPitchDeg,
  clampAltitude,
  formatAltitude,
  limitsFor,
  MAX_ALT_M,
  MIN_ALT_3D_M,
  MIN_ALT_FLAT_M,
  pinchAltitude,
  PLACE_SCALES,
  placeScale,
  SLIDER_MAX,
  sliderToAltitude,
  stepAltitude,
  STEP_IN,
  STEP_OUT,
  threeDActive,
  tiltOfPitch,
  touchDistance,
  touchMidpoint,
  wheelFactor,
  zoomPitchDeg,
  type PlaceScale,
} from "client/globe/zoom/model";

const flat = limitsFor(false);
const threeD = limitsFor(true);

describe("zoom model", () => {
  test("limits follow the imagery: 30 m over Google 3D, 400 m over flat imagery, 20,000 km at most", () => {
    expect(threeD).toEqual({ minM: MIN_ALT_3D_M, maxM: MAX_ALT_M });
    expect(flat).toEqual({ minM: MIN_ALT_FLAT_M, maxM: MAX_ALT_M });
    expect([MIN_ALT_3D_M, MIN_ALT_FLAT_M, MAX_ALT_M]).toEqual([30, 400, 20_000_000]);
    // Google 3D counts only with a keyed route and the tileset on screen.
    expect(threeDActive("google-direct", "shown")).toBe(true);
    expect(threeDActive("ion", "shown")).toBe(true);
    expect(threeDActive("ion", "hidden")).toBe(false);
    expect(threeDActive("google-direct", "failed")).toBe(false);
    expect(threeDActive("keyless", "shown")).toBe(false);
  });

  test("the whole planet fits at the maximum: a 60° field of view over a 1440×900 canvas", () => {
    const halfVertical = Math.atan(Math.tan(Math.PI / 6) * (900 / 1440));
    const earthR = 6_371_000;
    // Distance from the centre at which the disc's limb is inside the narrower half angle.
    expect(MAX_ALT_M + earthR).toBeGreaterThan(earthR / Math.sin(halfVertical));
  });

  test("log-scale slider ↔ altitude round trips within 1 percent", () => {
    for (const limits of [flat, threeD]) {
      expect(sliderToAltitude(0, limits)).toBeCloseTo(limits.maxM, 0);
      expect(sliderToAltitude(SLIDER_MAX, limits)).toBeCloseTo(limits.minM, 6);
      for (const alt of [limits.minM, 850, 1_200, 12_000, 45_000, 300_000, 4_000_000, limits.maxM]) {
        const back = sliderToAltitude(altitudeToSlider(alt, limits), limits);
        expect(Math.abs(back - alt) / alt).toBeLessThan(0.01);
      }
      for (let v = 0; v <= SLIDER_MAX; v += 7.5) expect(altitudeToSlider(sliderToAltitude(v, limits), limits)).toBeCloseTo(v, 6);
    }
    // Equal slider distances are equal zoom ratios.
    const r1 = sliderToAltitude(20, flat) / sliderToAltitude(30, flat);
    const r2 = sliderToAltitude(70, flat) / sliderToAltitude(80, flat);
    expect(r1).toBeCloseTo(r2, 9);
    // Out of range values clamp to the ends.
    expect(altitudeToSlider(1, flat)).toBe(SLIDER_MAX);
    expect(altitudeToSlider(1e9, flat)).toBe(0);
    expect(sliderToAltitude(-5, flat)).toBe(flat.maxM);
  });

  test("a step is ×0.5 in and ×2 out per press, clamped", () => {
    expect([STEP_IN, STEP_OUT]).toEqual([0.5, 2]);
    expect(stepAltitude(12_000, 1, flat)).toBe(6_000);
    expect(stepAltitude(12_000, -1, flat)).toBe(24_000);
    expect(stepAltitude(12_000, 2, flat)).toBe(3_000);
    expect(stepAltitude(500, 1, flat)).toBe(MIN_ALT_FLAT_M);
    expect(stepAltitude(500, 1, threeD)).toBe(250);
    expect(stepAltitude(15_000_000, -1, flat)).toBe(MAX_ALT_M);
  });

  test("clamp keeps the altitude in [min, max]", () => {
    expect(clampAltitude(5, threeD)).toBe(30);
    expect(clampAltitude(5, flat)).toBe(400);
    expect(clampAltitude(50_000_000, flat)).toBe(MAX_ALT_M);
    expect(clampAltitude(12_345, flat)).toBe(12_345);
    expect(clampAltitude(Number.NaN, flat)).toBe(MAX_ALT_M);
  });

  test("place-scale labels at the stated thresholds", () => {
    expect(PLACE_SCALES.map((s) => s.name)).toEqual(["World", "Country", "State or region", "County", "City", "Neighbourhood", "Street"]);
    const cases: [number, PlaceScale][] = [
      [20_000_000, "World"],
      [6_000_000, "World"],
      [5_999_999, "Country"],
      [1_500_000, "Country"],
      [1_499_999, "State or region"],
      [300_000, "State or region"],
      [299_999, "County"],
      [60_000, "County"],
      [59_999, "City"],
      [12_000, "City"],
      [8_000, "City"],
      [7_999, "Neighbourhood"],
      [1_500, "Neighbourhood"],
      [1_499, "Street"],
      [30, "Street"],
    ];
    for (const [alt, name] of cases) expect(placeScale(alt)).toBe(name);
  });

  test("formatted readout", () => {
    expect(formatAltitude(12_000)).toBe("12 km");
    expect(formatAltitude(850)).toBe("850 m");
    expect(formatAltitude(853)).toBe("850 m");
    expect(formatAltitude(30)).toBe("30 m");
    expect(formatAltitude(999)).toBe("1 km");
    expect(formatAltitude(4_500)).toBe("4.5 km");
    expect(formatAltitude(4_000)).toBe("4 km");
    expect(formatAltitude(12_400)).toBe("12 km");
    expect(formatAltitude(1_200_000)).toBe("1,200 km");
    expect(formatAltitude(20_000_000)).toBe("20,000 km");
    expect(altitudeValueText(12_000)).toBe("City, 12 km up");
    expect(altitudeValueText(850)).toBe("Street, 850 m up");
  });

  test("wheel: one notch is about 20 percent, bursts are capped, line and page modes convert", () => {
    expect(1 - wheelFactor(-100)).toBeCloseTo(0.2, 6);
    expect(wheelFactor(100) - 1).toBeCloseTo(0.25, 6);
    expect(wheelFactor(0)).toBe(1);
    expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-99), 6);
    expect(wheelFactor(-10_000)).toBeCloseTo(wheelFactor(-300), 9);
    // A trackpad pinch (ctrlKey) sends small deltas: scaled up to feel like the wheel.
    expect(wheelFactor(-25, 0, true)).toBeCloseTo(wheelFactor(-100), 9);
  });

  test("touch pinch scale → altitude ratio", () => {
    const a = { x: 100, y: 200 };
    const b = { x: 200, y: 200 };
    expect(touchDistance(a, b)).toBe(100);
    expect(touchMidpoint(a, b)).toEqual({ x: 150, y: 200 });
    // Fingers twice as far apart: half the altitude; together: twice.
    expect(pinchAltitude(12_000, 100, 200, flat)).toBe(6_000);
    expect(pinchAltitude(12_000, 100, 50, flat)).toBe(24_000);
    expect(pinchAltitude(12_000, 100, 100, flat)).toBe(12_000);
    // Clamped, and a degenerate start keeps the altitude.
    expect(pinchAltitude(1_000, 100, 1_000, flat)).toBe(MIN_ALT_FLAT_M);
    expect(pinchAltitude(1_000, 100, 1_000, threeD)).toBe(100);
    expect(pinchAltitude(12_000, 0, 50, flat)).toBe(12_000);
  });

  test("auto tilt: straight down above 5 km, easing to 45° at 500 m", () => {
    expect(autoPitchDeg(20_000)).toBe(-90);
    expect(autoPitchDeg(5_000)).toBe(-90);
    expect(autoPitchDeg(500)).toBe(-45);
    expect(autoPitchDeg(30)).toBe(-45);
    const mid = autoPitchDeg(Math.sqrt(5_000 * 500));
    expect(mid).toBeCloseTo(-67.5, 6);
    expect(tiltOfPitch(-90)).toBe(0);
    expect(tiltOfPitch(-45)).toBe(45);
  });
});

describe("zoom controls placement", () => {
  test("the rightmost slot clear of the cards on the right", () => {
    // Nothing in the way: against the right limit.
    expect(rightmostSlot(452, 988, 132, [])).toBe(988);
    // The sighting card (608..1008) open: left of it, with the gap.
    expect(rightmostSlot(452, 988, 132, [[608, 1008]])).toBe(596);
    // Two cards side by side leave no room for the full column, nor for the pair.
    expect(rightmostSlot(464, 988, 132, [[816, 1012], [464, 804]])).toBeNull();
    expect(rightmostSlot(464, 988, 48, [[816, 1012], [464, 804]])).toBeNull();
    // A card far left of the slot does not move it; one just right of it (within the gap) does.
    expect(rightmostSlot(452, 988, 132, [[460, 600]])).toBe(988);
    expect(rightmostSlot(452, 988, 132, [[995, 1020]])).toBe(983);
  });
});

describe("zoom tilt with a stubbed route", () => {
  const pitchFor = (route: string, google3d: string, from: number, pitch: number, to: number) => zoomPitchDeg(threeDActive(route, google3d), from, pitch, to);

  test("Google 3D on screen: zooming below 5 km tilts the view", () => {
    expect(pitchFor("google-direct", "shown", 8_000, -90, 4_000)).toBeGreaterThan(-90);
    expect(pitchFor("google-direct", "shown", 8_000, -90, 1_000)).toBeCloseTo(autoPitchDeg(1_000), 9);
    expect(pitchFor("ion", "shown", 2_000, autoPitchDeg(2_000), 500)).toBe(-45);
    // Zooming back out returns to straight down.
    expect(pitchFor("google-direct", "shown", 1_000, autoPitchDeg(1_000), 16_000)).toBe(-90);
  });

  test("flat imagery stays top down", () => {
    expect(pitchFor("keyless", "off", 8_000, -90, 1_000)).toBe(-90);
    expect(pitchFor("ion", "hidden", 8_000, -90, 1_000)).toBe(-90);
    expect(pitchFor("google-direct", "failed", 8_000, -90, 1_000)).toBe(-90);
  });

  test("a view the user tilted by hand is left alone, and a pinch never tilts", () => {
    expect(pitchFor("google-direct", "shown", 8_000, -60, 1_000)).toBe(-60);
    expect(zoomPitchDeg(true, 8_000, -90, 1_000, false)).toBe(-90);
  });
});
