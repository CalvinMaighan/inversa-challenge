import { describe, expect, test } from "bun:test";

import {
  decodeEnvC,
  decodeHotspot,
  ENV_UPSCALE,
  envIndex,
  everValidMask,
  HATCH_PERIOD,
  HATCH_RGBA,
  HEAT_FLOOR,
  HEAT_STOPS,
  heatLut,
  LST_RANGE_C,
  paintEnv,
  paintHeat,
  sampleRamp,
  tempLut,
} from "client/globe/ramp";
import { ENV_FLAGGED, ENV_MISSING } from "shared/frames";

const px = (out: Uint8ClampedArray, i: number) => [...out.subarray(i * 4, i * 4 + 4)];

describe("colour ramps", () => {
  test("sampleRamp hits the stops exactly and interpolates between them", () => {
    expect(sampleRamp(HEAT_STOPS, 0)).toEqual([40, 11, 84, Math.round(0.22 * 255)]);
    expect(sampleRamp(HEAT_STOPS, 1)).toEqual([252, 255, 164, Math.round(0.9 * 255)]);
    const mid = sampleRamp([[0, 0, 0, 0, 0], [1, 200, 100, 50, 1]], 0.5);
    expect(mid).toEqual([100, 50, 25, 128]);
    expect(sampleRamp(HEAT_STOPS, -3)).toEqual(sampleRamp(HEAT_STOPS, 0));
    expect(sampleRamp(HEAT_STOPS, Number.NaN)).toEqual(sampleRamp(HEAT_STOPS, 0));
  });

  test("heat LUT: zero and sub-floor bytes are clear; alpha and brightness rise with score", () => {
    const lut = heatLut();
    const floorByte = Math.ceil(HEAT_FLOOR * 255);
    expect(px(lut, 0)).toEqual([0, 0, 0, 0]);
    expect(lut[(floorByte - 1) * 4 + 3]).toBe(0);
    expect(lut[floorByte * 4 + 3]).toBeGreaterThan(0);
    for (let v = floorByte + 1; v < 256; v += 1) expect(lut[v * 4 + 3]!).toBeGreaterThanOrEqual(lut[(v - 1) * 4 + 3]!);
    const luma = (v: number) => lut[v * 4]! + lut[v * 4 + 1]! + lut[v * 4 + 2]!;
    expect(luma(255)).toBeGreaterThan(luma(128));
    expect(luma(128)).toBeGreaterThan(luma(floorByte));
  });

  test("temperature LUT runs cold blue to hot red", () => {
    const lut = tempLut();
    expect(lut[2]!).toBeGreaterThan(lut[0]!); // blue end
    expect(lut[255 * 4]!).toBeGreaterThan(lut[255 * 4 + 2]!); // red end
  });
});

describe("quantization decode (EVF2)", () => {
  test("hotspot score = u8 × hotspotScale", () => {
    expect(decodeHotspot(0, 1 / 255)).toBe(0);
    expect(decodeHotspot(255, 1 / 255)).toBeCloseTo(1);
    expect(decodeHotspot(51, 0.02)).toBeCloseTo(1.02);
  });

  test("env cells are centi-°C with -32768 missing", () => {
    expect(decodeEnvC(2315)).toBeCloseTo(23.15);
    expect(decodeEnvC(-450)).toBeCloseTo(-4.5);
    expect(decodeEnvC(ENV_MISSING)).toBeNull();
  });

  test("envIndex clamps into the display range", () => {
    expect(envIndex(LST_RANGE_C.min * 100, LST_RANGE_C)).toBe(0);
    expect(envIndex(LST_RANGE_C.max * 100, LST_RANGE_C)).toBe(255);
    expect(envIndex(-2000, LST_RANGE_C)).toBe(0);
    expect(envIndex(9000, LST_RANGE_C)).toBe(255);
    expect(envIndex(2250, LST_RANGE_C)).toBe(128);
  });
});

describe("paintHeat", () => {
  test("takes the per-cell max over species and flips rows so north is up", () => {
    const cols = 3;
    const rows = 2;
    const python = new Uint8Array([0, 200, 0, 0, 0, 0]); // south row, middle cell
    const lionfish = new Uint8Array([0, 90, 0, 0, 0, 255]); // north row, east cell
    const lut = heatLut();
    const out = new Uint8ClampedArray(cols * rows * 4);
    const { painted, peak } = paintHeat(out, cols, rows, [python, lionfish], lut);
    expect(peak).toBe(255);
    expect(painted).toBe(2);
    // Canvas row 0 is north: grid row 1.
    expect(px(out, 2)).toEqual([...lut.subarray(255 * 4, 255 * 4 + 4)]);
    // Canvas row 1 is south: grid row 0; max(200, 90) = 200.
    expect(px(out, 3 + 1)).toEqual([...lut.subarray(200 * 4, 200 * 4 + 4)]);
    expect(px(out, 0)).toEqual([0, 0, 0, 0]);
  });

  test("no species enabled paints everything clear", () => {
    const out = new Uint8ClampedArray(4 * 4).fill(9);
    expect(paintHeat(out, 2, 2, [], heatLut()).painted).toBe(0);
    expect([...out]).toEqual(new Array(16).fill(0));
  });

  test("rejects an undersized buffer", () => {
    expect(() => paintHeat(new Uint8ClampedArray(4), 2, 2, [], heatLut())).toThrow(RangeError);
  });
});

describe("paintEnv", () => {
  const lut = tempLut();
  const k = ENV_UPSCALE;

  test("valid cells take the ramp; gaps hatch; never-valid cells stay clear", () => {
    const cols = 3;
    const rows = 1;
    const values = new Int16Array([2000, ENV_MISSING, ENV_MISSING]);
    const everValid = new Uint8Array([1, 1, 0]);
    const out = new Uint8ClampedArray(cols * k * rows * k * 4);
    const { valid, gaps } = paintEnv(out, cols, rows, values, lut, LST_RANGE_C, k, everValid);
    expect(valid).toBe(1);
    expect(gaps).toBe(1);
    const width = cols * k;
    const at = (x: number, y: number) => px(out, y * width + x);
    const colour = [...lut.subarray(envIndex(2000, LST_RANGE_C) * 4, envIndex(2000, LST_RANGE_C) * 4 + 4)];
    for (let y = 0; y < k; y += 1) for (let x = 0; x < k; x += 1) expect(at(x, y)).toEqual(colour);
    // Gap cell: hatch exactly on the diagonals (x + y) % period == 0, clear elsewhere.
    for (let y = 0; y < k; y += 1) {
      for (let x = k; x < 2 * k; x += 1) {
        expect(at(x, y)).toEqual((x + y) % HATCH_PERIOD === 0 ? [...HATCH_RGBA] : [0, 0, 0, 0]);
      }
    }
    // Out-of-domain cell: fully clear.
    for (let y = 0; y < k; y += 1) for (let x = 2 * k; x < 3 * k; x += 1) expect(at(x, y)).toEqual([0, 0, 0, 0]);
  });

  test("north is up and a missing mask treats every missing cell as a gap", () => {
    const values = new Int16Array([ENV_MISSING, 3000]); // row 0 (south) missing, row 1 (north) valid
    const out = new Uint8ClampedArray(k * 2 * k * 4);
    const { gaps } = paintEnv(out, 1, 2, values, lut, LST_RANGE_C, k, null);
    expect(gaps).toBe(1);
    expect(out[3]).toBeGreaterThan(0); // top-left pixel is the valid north cell
  });

  test("everValidMask marks cells valid in any frame", () => {
    const frames = [new Int16Array([ENV_MISSING, 1, ENV_MISSING]), new Int16Array([ENV_MISSING, ENV_MISSING, 5])];
    expect([...everValidMask(frames, 3)]).toEqual([0, 1, 1]);
  });

  test("a flagged pixel (cloud, bad DQF) hatches even when it never cleared in the window", () => {
    // One GOES scan: cell 0 valid, cell 1 cloud, cell 2 outside the product.
    const values = new Int16Array([2000, ENV_FLAGGED, ENV_MISSING]);
    const mask = everValidMask([values], 3);
    expect([...mask]).toEqual([1, 1, 0]);
    const out = new Uint8ClampedArray(3 * k * k * 4);
    expect(paintEnv(out, 3, 1, values, lut, LST_RANGE_C, k, mask)).toEqual({ valid: 1, gaps: 1 });
    // Without a mask as well: flagged is a gap by itself.
    expect(paintEnv(out, 3, 1, values, lut, LST_RANGE_C, k, new Uint8Array(3)).gaps).toBe(1);
    expect(decodeEnvC(ENV_FLAGGED)).toBeNull();
  });
});
