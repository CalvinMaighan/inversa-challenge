/**
 * Colour ramps and raster painters for the grid layers. Pure over typed arrays: the layers hand in an
 * `ImageData.data` buffer, the tests hand in a plain `Uint8ClampedArray`.
 *
 * Grids are row-major from the south-west corner (PLAN.md C4); canvases are row-major from the top, so every
 * painter flips rows to put north up.
 */
import { ENV_MISSING } from "shared/frames";

/** A colour stop: position in [0, 1], then r, g, b in 0..255 and alpha in 0..1. */
export type RampStop = readonly [t: number, r: number, g: number, b: number, a: number];

/** Hotspot scores below this fraction of full scale stay transparent, so faint noise does not tint the map. */
export const HEAT_FLOOR = 0.08;

/** Inferno-like: dark violet at low scores through crimson and orange to pale yellow, alpha rising with score. */
export const HEAT_STOPS: readonly RampStop[] = [
  [0, 40, 11, 84, 0.22],
  [0.3, 136, 34, 106, 0.48],
  [0.55, 212, 72, 66, 0.64],
  [0.8, 249, 142, 9, 0.78],
  [1, 252, 255, 164, 0.9],
];

/** Diverging cold-to-hot (RdYlBu reversed); the cold end matters most for the iguana cold-snap story. */
export const TEMP_STOPS: readonly RampStop[] = [
  [0, 49, 54, 149, 0.62],
  [0.2, 69, 117, 180, 0.62],
  [0.4, 171, 217, 233, 0.58],
  [0.6, 254, 224, 144, 0.58],
  [0.8, 244, 109, 67, 0.62],
  [1, 165, 0, 38, 0.66],
];

/** Display ranges, °C. LST swings far wider than the sea surface. */
export const LST_RANGE_C = { min: 0, max: 45 } as const;
export const SST_RANGE_C = { min: 16, max: 33 } as const;

/** Hatch drawn over cells that are missing in this frame but valid in others (cloud, bad DQF). */
export const HATCH_RGBA = [214, 219, 228, 96] as const;
/** Hatch line spacing, output pixels. */
export const HATCH_PERIOD = 6;
/** Environment cells are upscaled by this factor so the hatch has room to read. */
export const ENV_UPSCALE = 4;

/** Linear interpolation through `stops` at `t` (clamped), as RGBA bytes. */
export function sampleRamp(stops: readonly RampStop[], t: number): [number, number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let i = 1;
  while (i < stops.length - 1 && stops[i]![0] < x) i += 1;
  const lo = stops[i - 1]!;
  const hi = stops[i]!;
  const span = hi[0] - lo[0];
  const f = span > 0 ? Math.min(1, Math.max(0, (x - lo[0]) / span)) : 0;
  const mix = (a: number, b: number) => a + (b - a) * f;
  return [Math.round(mix(lo[1], hi[1])), Math.round(mix(lo[2], hi[2])), Math.round(mix(lo[3], hi[3])), Math.round(mix(lo[4], hi[4]) * 255)];
}

/** 256-entry RGBA table indexed by the raw hotspot byte. Entry 0 and everything under the floor are clear. */
export function heatLut(stops: readonly RampStop[] = HEAT_STOPS, floor = HEAT_FLOOR): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const first = Math.max(1, Math.ceil(floor * 255));
  for (let v = first; v < 256; v += 1) {
    const t = (v - first) / Math.max(1, 255 - first);
    lut.set(sampleRamp(stops, t), v * 4);
  }
  return lut;
}

/** 256-entry RGBA table over [minC, maxC]; index with `envIndex`. */
export function tempLut(stops: readonly RampStop[] = TEMP_STOPS): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i += 1) lut.set(sampleRamp(stops, i / 255), i * 4);
  return lut;
}

/** Hotspot score from its quantized byte (C4: `score = u8 × hotspotScale`). */
export function decodeHotspot(byte: number, hotspotScale: number): number {
  return byte * hotspotScale;
}

/** °C from an i16 centi-degree cell, or null when missing or flagged. */
export function decodeEnvC(centi: number): number | null {
  return centi === ENV_MISSING ? null : centi / 100;
}

/** LUT index for a centi-degree value within a display range. */
export function envIndex(centi: number, range: { min: number; max: number }): number {
  const t = (centi / 100 - range.min) / (range.max - range.min);
  return Math.round(Math.min(1, Math.max(0, t)) * 255);
}

/**
 * Paint the per-cell maximum over `species` (the enabled species' u8 grids) into `out`, cols × rows RGBA, north
 * up. Returns the number of painted (non-clear) cells and the peak byte.
 */
export function paintHeat(
  out: Uint8ClampedArray,
  cols: number,
  rows: number,
  species: readonly Uint8Array[],
  lut: Uint8ClampedArray,
): { painted: number; peak: number } {
  const cells = cols * rows;
  if (out.length < cells * 4) throw new RangeError(`paintHeat: out holds ${out.length} bytes, needs ${cells * 4}`);
  let painted = 0;
  let peak = 0;
  for (let r = 0; r < rows; r += 1) {
    const src = r * cols;
    const dst = (rows - 1 - r) * cols;
    for (let c = 0; c < cols; c += 1) {
      let v = 0;
      for (const grid of species) {
        const s = grid[src + c]!;
        if (s > v) v = s;
      }
      const o = (dst + c) * 4;
      const l = v * 4;
      out[o] = lut[l]!;
      out[o + 1] = lut[l + 1]!;
      out[o + 2] = lut[l + 2]!;
      out[o + 3] = lut[l + 3]!;
      if (lut[l + 3]! > 0) painted += 1;
      if (v > peak) peak = v;
    }
  }
  return { painted, peak };
}

/**
 * Cells valid in at least one of `frames`. A cell never valid is outside the product's domain (land for SST,
 * open sea for LST) and stays clear; a cell valid elsewhere but missing now is a gap and gets hatched.
 */
export function everValidMask(frames: Iterable<Int16Array>, cells: number): Uint8Array {
  const mask = new Uint8Array(cells);
  let remaining = cells;
  for (const values of frames) {
    for (let i = 0; i < cells; i += 1) {
      if (mask[i] === 0 && values[i] !== ENV_MISSING) {
        mask[i] = 1;
        remaining -= 1;
      }
    }
    if (remaining === 0) break;
  }
  return mask;
}

/**
 * Paint an environment grid upscaled by `k` into `out` ((cols·k) × (rows·k) RGBA, north up). Valid cells take
 * the ramp colour; gaps (missing now, valid in `everValid`) get a diagonal hatch; out-of-domain cells stay
 * clear. With no mask every missing cell counts as a gap. Returns counts for layer stats.
 */
export function paintEnv(
  out: Uint8ClampedArray,
  cols: number,
  rows: number,
  values: Int16Array,
  lut: Uint8ClampedArray,
  range: { min: number; max: number },
  k: number,
  everValid: Uint8Array | null,
): { valid: number; gaps: number } {
  const width = cols * k;
  const height = rows * k;
  if (out.length < width * height * 4) throw new RangeError(`paintEnv: out holds ${out.length} bytes, needs ${width * height * 4}`);
  let valid = 0;
  let gaps = 0;
  for (let r = 0; r < rows; r += 1) {
    const top = (rows - 1 - r) * k;
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      const v = values[idx]!;
      const missing = v === ENV_MISSING;
      const gap = missing && (everValid === null || everValid[idx] === 1);
      if (!missing) valid += 1;
      else if (gap) gaps += 1;
      const l = missing ? -1 : envIndex(v, range) * 4;
      for (let y = top; y < top + k; y += 1) {
        let o = (y * width + c * k) * 4;
        for (let x = c * k; x < c * k + k; x += 1, o += 4) {
          if (l >= 0) {
            out[o] = lut[l]!;
            out[o + 1] = lut[l + 1]!;
            out[o + 2] = lut[l + 2]!;
            out[o + 3] = lut[l + 3]!;
          } else if (gap && (x + y) % HATCH_PERIOD === 0) {
            out[o] = HATCH_RGBA[0];
            out[o + 1] = HATCH_RGBA[1];
            out[o + 2] = HATCH_RGBA[2];
            out[o + 3] = HATCH_RGBA[3];
          } else {
            out[o] = 0;
            out[o + 1] = 0;
            out[o + 2] = 0;
            out[o + 3] = 0;
          }
        }
      }
    }
  }
  return { valid, gaps };
}
