/**
 * Development frames, so `next dev` shows a populated globe before the db worker (T19) publishes real ones.
 * Loads `spec/frames/sample.evf` through the dev-only `/dev/globe/sample-evf` route when it is EVF2, and
 * otherwise synthesises a day of 15-minute frames: species hotspots with diurnal activity, a cold front that
 * suppresses the reptiles late in the day, LST over land and SST over water with drifting cloud gaps, and a
 * trickle of sightings near the hotspots. Deterministic (seeded) so screenshots compare.
 *
 * The caller gates this behind `process.env.NODE_ENV !== "production"`; nothing here ships in a build.
 */
import { allocFrameGrid, type FrameGrid } from "@calvinjs/active-state/threads";

import { REGION_BBOX } from "client/state/view";
import { ENV_MISSING, EVF_SPECIES } from "shared/frames";

import type { FrameTimeline, SightingRecord } from "./api";
import { gridFromEvf } from "./evf";
import { assumedFrame0 } from "./frame-index";

export const DEV_SAMPLE_URL = "/dev/globe/sample-evf";

/** C4 grid sizes over the C15 bbox. */
const HS_COLS = 170;
const HS_ROWS = 160;
const ENV_COLS = 68;
const ENV_ROWS = 64;
const HS_DEG = 0.02;
const ENV_DEG = 0.05;

/** Mainland South Florida, coarse, counter-clockwise from the Gulf coast at the bbox's north edge. */
const MAINLAND: readonly (readonly [number, number])[] = [
  [-82.66, 27.5],
  [-82.55, 27.2],
  [-82.3, 26.85],
  [-82.0, 26.5],
  [-81.85, 26.2],
  [-81.7, 25.95],
  [-81.35, 25.8],
  [-81.15, 25.4],
  [-80.95, 25.14],
  [-80.55, 25.2],
  [-80.38, 25.35],
  [-80.3, 25.55],
  [-80.2, 25.75],
  [-80.12, 26.0],
  [-80.08, 26.4],
  [-80.04, 26.9],
  [-80.1, 27.5],
];

export function onMainland(lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = MAINLAND.length - 1; i < MAINLAND.length; j = i, i += 1) {
    const [xi, yi] = MAINLAND[i]!;
    const [xj, yj] = MAINLAND[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** mulberry32: small, fast, good enough for fixture noise. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Blob = { lon: number; lat: number; sigma: number; peak: number };

/** Hotspot centres per species, in EVF_SPECIES order: python, tegu, iguana, lionfish. */
const BLOBS: readonly (readonly Blob[])[] = [
  [
    { lon: -80.85, lat: 25.7, sigma: 0.14, peak: 0.95 },
    { lon: -80.62, lat: 25.42, sigma: 0.1, peak: 0.8 },
    { lon: -81.2, lat: 25.95, sigma: 0.12, peak: 0.6 },
  ],
  [
    { lon: -80.46, lat: 25.5, sigma: 0.09, peak: 0.9 },
    { lon: -80.35, lat: 25.62, sigma: 0.06, peak: 0.55 },
  ],
  [
    { lon: -80.19, lat: 25.87, sigma: 0.07, peak: 0.9 },
    { lon: -81.78, lat: 24.56, sigma: 0.06, peak: 0.8 },
    { lon: -80.1, lat: 26.6, sigma: 0.08, peak: 0.7 },
    { lon: -80.62, lat: 24.92, sigma: 0.05, peak: 0.6 },
  ],
  [
    { lon: -80.34, lat: 24.95, sigma: 0.1, peak: 0.85 },
    { lon: -81.45, lat: 24.48, sigma: 0.12, peak: 0.75 },
    { lon: -80.03, lat: 26.2, sigma: 0.08, peak: 0.7 },
  ],
];

/** Hour of peak activity (local, UTC−5) per species; lionfish do not follow the sun. */
const PEAK_HOUR = [22, 13, 12, -1];

export type FixtureFrames = { grid: FrameGrid; timeline: FrameTimeline };

/** A synthetic day ending at `toMs`, one frame per `stepMs`. */
export function syntheticFrames({ toMs, stepMs, frameCount, seed = 17 }: { toMs: number; stepMs: number; frameCount: number; seed?: number }): FixtureFrames {
  const grid = allocFrameGrid({
    frameCount,
    hsCols: HS_COLS,
    hsRows: HS_ROWS,
    speciesCount: EVF_SPECIES.length,
    envCols: ENV_COLS,
    envRows: ENV_ROWS,
    hotspotScale: 1 / 255,
  });
  const frame0Ms = assumedFrame0(toMs, stepMs, frameCount);
  const random = rng(seed);
  const land = new Uint8Array(ENV_COLS * ENV_ROWS);
  for (let r = 0; r < ENV_ROWS; r += 1) {
    for (let c = 0; c < ENV_COLS; c += 1) {
      land[r * ENV_COLS + c] = onMainland(REGION_BBOX.west + (c + 0.5) * ENV_DEG, REGION_BBOX.south + (r + 0.5) * ENV_DEG) ? 1 : 0;
    }
  }
  const clouds = [0, 1, 2].map(() => ({
    lon: REGION_BBOX.west + random() * 3.4,
    lat: REGION_BBOX.south + random() * 3.2,
    dLon: 0.02 + random() * 0.03,
    dLat: -0.01 + random() * 0.02,
    radius: 0.25 + random() * 0.2,
  }));
  const sightings: SightingRecord[][] = [];

  for (let f = 0; f < frameCount; f += 1) {
    const t = frame0Ms + f * stepMs;
    const hourLocal = (((t / 3_600_000 - 5) % 24) + 24) % 24;
    // Cold front sweeps in over the last third of the window, reaching 10 °C below normal.
    const front = Math.min(1, Math.max(0, (f / frameCount - 0.62) / 0.3));

    for (let s = 0; s < EVF_SPECIES.length; s += 1) {
      const peak = PEAK_HOUR[s]!;
      const diurnal = peak < 0 ? 1 : 0.45 + 0.55 * Math.cos(((hourLocal - peak) / 24) * Math.PI) ** 2;
      const cold = s === EVF_SPECIES.length - 1 ? 1 : 1 - 0.7 * front;
      const cells = grid.hotspot(f, s);
      for (const blob of BLOBS[s]!) {
        const amp = blob.peak * diurnal * cold;
        const reach = blob.sigma * 3;
        const c0 = Math.max(0, Math.floor((blob.lon - reach - REGION_BBOX.west) / HS_DEG));
        const c1 = Math.min(HS_COLS - 1, Math.ceil((blob.lon + reach - REGION_BBOX.west) / HS_DEG));
        const r0 = Math.max(0, Math.floor((blob.lat - reach - REGION_BBOX.south) / HS_DEG));
        const r1 = Math.min(HS_ROWS - 1, Math.ceil((blob.lat + reach - REGION_BBOX.south) / HS_DEG));
        for (let r = r0; r <= r1; r += 1) {
          const dLat = REGION_BBOX.south + (r + 0.5) * HS_DEG - blob.lat;
          for (let c = c0; c <= c1; c += 1) {
            const dLon = REGION_BBOX.west + (c + 0.5) * HS_DEG - blob.lon;
            const v = Math.round(255 * amp * Math.exp(-(dLon * dLon + dLat * dLat) / (2 * blob.sigma * blob.sigma)));
            const i = r * HS_COLS + c;
            if (v > cells[i]!) cells[i] = Math.min(255, v);
          }
        }
      }
    }

    const lst = grid.lst(f);
    const sst = grid.sst(f);
    for (let r = 0; r < ENV_ROWS; r += 1) {
      const lat = REGION_BBOX.south + (r + 0.5) * ENV_DEG;
      for (let c = 0; c < ENV_COLS; c += 1) {
        const lon = REGION_BBOX.west + (c + 0.5) * ENV_DEG;
        const i = r * ENV_COLS + c;
        const cloudy = clouds.some((k) => {
          const dx = lon - (k.lon + k.dLon * f);
          const dy = lat - (k.lat + k.dLat * f);
          return dx * dx + dy * dy < k.radius * k.radius;
        });
        const northFront = front * Math.min(1, Math.max(0, (lat - 24.3) / 1.6 + 0.3));
        if (land[i]) {
          const c0 = 26 + 7 * Math.sin(((hourLocal - 9) / 24) * 2 * Math.PI) - 0.8 * (lat - 24.3) - 12 * northFront;
          lst[i] = cloudy ? ENV_MISSING : Math.round(c0 * 100);
          sst[i] = ENV_MISSING;
        } else {
          const gulfStream = lon > -80.1 ? 1.5 : 0;
          const c0 = 27.5 - 1.1 * (lat - 24.3) + gulfStream + 0.3 * Math.sin(((hourLocal - 14) / 24) * 2 * Math.PI) - 3 * northFront;
          sst[i] = cloudy ? ENV_MISSING : Math.round(c0 * 100);
          lst[i] = ENV_MISSING;
        }
      }
    }

    const records: SightingRecord[] = [];
    for (let s = 0; s < EVF_SPECIES.length; s += 1) {
      for (const blob of BLOBS[s]!) {
        if (random() > blob.peak * 0.35 * (1 - 0.6 * front * (s < 3 ? 1 : 0))) continue;
        const jitter = () => (random() + random() + random() - 1.5) * blob.sigma;
        records.push({
          lon: blob.lon + jitter(),
          lat: blob.lat + jitter(),
          taxon: s + 1,
          quality: [0, 0, 0, 1, 2][Math.floor(random() * 5)]!,
          flags: random() < 0.04 ? 2 : 0,
          id: `dev-${f}-${records.length}`,
        });
      }
    }
    sightings.push(records);
  }
  grid.bump();
  return { grid, timeline: { frame0Ms, stepMs, frameCount, sightings: (i) => sightings[i] ?? [] } };
}

export type DevFrames = FixtureFrames & { source: "sample" | "synthetic"; note: string };

/**
 * The sample file when it is EVF2 over the full C4 grid, re-based so its last frame sits on `toMs` (its own
 * dates are outside the live replay window). The golden sample T11 ships is a 10 × 5-cell, 3-frame patch for
 * unit tests; it loads only with `force` (`/dev/globe?fixture=sample`), otherwise the synthetic day is used
 * so the globe is visibly populated.
 */
export async function loadDevFrames({
  toMs,
  stepMs,
  force = false,
  fetchImpl = fetch,
}: {
  toMs: number;
  stepMs: number;
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<DevFrames> {
  let note = "sample.evf not served";
  try {
    const res = await fetchImpl(DEV_SAMPLE_URL);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { grid, index, sightings } = gridFromEvf(bytes);
      const h = index.header;
      const full = h.hsCols === HS_COLS && h.hsRows === HS_ROWS && h.envCols === ENV_COLS && h.envRows === ENV_ROWS;
      if (full || force) {
        const step = h.stepMinutes * 60_000 || stepMs;
        return {
          grid,
          timeline: {
            frame0Ms: assumedFrame0(toMs, step, h.frameCount),
            stepMs: step,
            frameCount: h.frameCount,
            sightings: (i) => sightings[i] ?? [],
            geometry: { west: h.west, south: h.south, hsCellDeg: h.hsCellDeg, envCellDeg: h.envCellDeg },
          },
          source: "sample",
          note: `sample.evf ${h.hsCols}×${h.hsRows} cells, ${h.frameCount} frames`,
        };
      }
      note = `sample.evf is a ${h.hsCols}×${h.hsRows}-cell patch, not the full grid`;
    }
  } catch (err) {
    note = `sample.evf unreadable (${err instanceof Error ? err.message : String(err)})`;
  }
  return { ...syntheticFrames({ toMs, stepMs, frameCount: 96 }), source: "synthetic", note };
}
