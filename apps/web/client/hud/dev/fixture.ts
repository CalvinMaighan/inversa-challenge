/**
 * Synthetic EVF2 frames (PLAN.md C4) for the HUD's dev route and e2e scrub test. Deterministic: a seeded PRNG,
 * a rough Florida land mask, a diurnal LST cycle, species hotspot blobs, and scripted data problems so the
 * timeline has something to hatch:
 *
 * - a biological feed silence (no sightings for 12.5 h) → `NO_SIGHTINGS`
 * - a cloud deck over most of the region for three hours → `CLOUD`
 * - a two-hour GOES outage (every env cell missing) → `ENV_MISSING`
 * - small scattered clouds elsewhere, under the cloud threshold → not a gap
 */
import { ENV_MISSING, EVF_HEADER_BYTES, EVF_MAGIC, EVF_SPECIES, evfFrameBytes, evfFrameLayout, SIGHTING_FLAG, type EvfHeader } from "shared/frames";

import { REGION_BBOX } from "client/state/view";

export const FIXTURE_FRAMES = 96;
export const FIXTURE_STEP_MINUTES = 15;

/** Frame ranges `[start, end)` of the scripted problems. */
export const FIXTURE_SCRIPT = {
  quiet: [2, 52],
  cloud: [54, 66],
  outage: [72, 80],
} as const;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rough peninsula: land north of Florida Bay between a west and an east coastline. */
export function isLand(lon: number, lat: number): boolean {
  if (lat < 25.15) return false;
  const west = -81.8 - 0.28 * (lat - 26);
  const east = -80.12 - 0.06 * (lat - 26);
  return lon > west && lon < east;
}

type Blob = { lon: number; lat: number; sigma: number; peak: number };

/** Hotspot centres per species, in `EVF_SPECIES` order. */
const HOTSPOTS: Blob[][] = [
  [
    { lon: -80.9, lat: 25.55, sigma: 0.22, peak: 1 },
    { lon: -81.25, lat: 25.95, sigma: 0.14, peak: 0.7 },
  ],
  [{ lon: -80.5, lat: 25.45, sigma: 0.12, peak: 0.85 }],
  [
    { lon: -80.25, lat: 25.8, sigma: 0.1, peak: 0.95 },
    { lon: -80.15, lat: 26.3, sigma: 0.08, peak: 0.6 },
  ],
  [{ lon: -81.05, lat: 24.68, sigma: 0.18, peak: 0.9 }],
];

const inside = (f: number, [s, e]: readonly [number, number]) => f >= s && f < e;

export type SightingRecord = { lon: number; lat: number; taxon: number; frame: number };
export type Fixture = { bytes: Uint8Array; header: EvfHeader; records: SightingRecord[] };

export function buildFixtureEvf(frame0Ms: number, frames = FIXTURE_FRAMES, seed = 7): Fixture {
  const rand = mulberry32(seed);
  const header: EvfHeader = {
    frameCount: frames,
    hsCols: 170,
    hsRows: 160,
    west: REGION_BBOX.west,
    south: REGION_BBOX.south,
    hsCellDeg: 0.02,
    frame0UnixMs: frame0Ms,
    stepMinutes: FIXTURE_STEP_MINUTES,
    speciesCount: EVF_SPECIES.length,
    envCols: 68,
    envRows: 64,
    envCellDeg: 0.05,
    hotspotScale: 1 / 255,
  };
  const layout = evfFrameLayout(header);

  // Sighting counts first: they size each frame.
  const counts: number[] = [];
  for (let f = 0; f < frames; f++) {
    const hour = new Date(frame0Ms + f * FIXTURE_STEP_MINUTES * 60_000).getUTCHours();
    const daylight = hour >= 12 && hour <= 23 ? 1 : 0.25; // 08:00–19:00 EDT
    counts.push(inside(f, FIXTURE_SCRIPT.quiet) ? 0 : Math.round(rand() * 6 * daylight + (rand() < 0.5 * daylight ? 1 : 0)));
  }
  const total = EVF_HEADER_BYTES + counts.reduce((sum, n) => sum + evfFrameBytes(header, n), 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < 4; i++) view.setUint8(i, EVF_MAGIC.charCodeAt(i));
  view.setUint32(4, header.frameCount, true);
  view.setUint32(8, header.hsCols, true);
  view.setUint32(12, header.hsRows, true);
  view.setFloat64(16, header.west, true);
  view.setFloat64(24, header.south, true);
  view.setFloat64(32, header.hsCellDeg, true);
  view.setBigInt64(40, BigInt(header.frame0UnixMs), true);
  view.setUint32(48, header.stepMinutes, true);
  view.setUint32(52, header.speciesCount, true);
  view.setUint16(56, header.envCols, true);
  view.setUint16(58, header.envRows, true);
  view.setFloat32(60, header.envCellDeg, true);
  view.setFloat32(64, header.hotspotScale, true);

  const envLand = new Uint8Array(header.envCols * header.envRows);
  for (let r = 0; r < header.envRows; r++) {
    for (let c = 0; c < header.envCols; c++) {
      envLand[r * header.envCols + c] = isLand(header.west + (c + 0.5) * header.envCellDeg, header.south + (r + 0.5) * header.envCellDeg) ? 1 : 0;
    }
  }

  const records: SightingRecord[] = [];
  let offset = EVF_HEADER_BYTES;
  for (let f = 0; f < frames; f++) {
    const t = frame0Ms + f * FIXTURE_STEP_MINUTES * 60_000;
    const hourLocal = (new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60 - 4 + 24) % 24;
    const night = Math.cos(((hourLocal - 2) / 24) * 2 * Math.PI) * 0.5 + 0.5; // 1 at 02:00, 0 at 14:00

    // Hotspots: u8, species-major, row-major from the south-west corner.
    for (let s = 0; s < header.speciesCount; s++) {
      // Pythons move at night; the rest drift gently with the day.
      const activity = s === 0 ? 0.35 + 0.65 * night : 0.7 + 0.3 * Math.sin((f / frames) * Math.PI * 2 + s);
      const base = offset + s * header.hsCols * header.hsRows;
      for (let r = 0; r < header.hsRows; r++) {
        const lat = header.south + (r + 0.5) * header.hsCellDeg;
        for (let c = 0; c < header.hsCols; c++) {
          const lon = header.west + (c + 0.5) * header.hsCellDeg;
          let v = 0;
          for (const b of HOTSPOTS[s]!) {
            const d2 = ((lon - b.lon) ** 2 + (lat - b.lat) ** 2) / (2 * b.sigma * b.sigma);
            if (d2 < 9) v = Math.max(v, b.peak * Math.exp(-d2));
          }
          bytes[base + r * header.hsCols + c] = Math.round(Math.min(1, v * activity) * 255);
        }
      }
    }

    // Environment: LST over land, SST over water, centi-degC; clouds and the outage as ENV_MISSING.
    const outage = inside(f, FIXTURE_SCRIPT.outage);
    const deck = inside(f, FIXTURE_SCRIPT.cloud);
    const cloudLon = -83.4 + (f % 24) * 0.18;
    const lstC = 23 + 6 * Math.sin(((hourLocal - 9) / 24) * 2 * Math.PI);
    for (let r = 0; r < header.envRows; r++) {
      const lat = header.south + (r + 0.5) * header.envCellDeg;
      for (let c = 0; c < header.envCols; c++) {
        const lon = header.west + (c + 0.5) * header.envCellDeg;
        const i = r * header.envCols + c;
        const land = envLand[i] === 1;
        // Deck: everything north of a line that sweeps south, about 70 % of the region.
        const underDeck = deck && lat > 24.9 - (f - FIXTURE_SCRIPT.cloud[0]) * 0.02;
        // Scattered cell: a small moving cloud, well under the threshold.
        const scattered = (lon - cloudLon) ** 2 + (lat - 26.4) ** 2 < 0.09;
        const cloudy = outage || underDeck || scattered;
        const lst = !land || cloudy ? ENV_MISSING : Math.round((lstC + (lat - 25.9) * -0.8) * 100);
        const sst = land || cloudy ? ENV_MISSING : Math.round((28.2 - (lat - 24.3) * 0.35 + Math.sin(lon * 3) * 0.2) * 100);
        view.setInt16(offset + layout.lstOffset + i * 2, lst, true);
        view.setInt16(offset + layout.sstOffset + i * 2, sst, true);
      }
    }

    // Sightings: near a species hotspot, f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags.
    const at = offset + layout.sightingsOffset;
    const n = counts[f]!;
    view.setUint32(at, n, true);
    for (let k = 0; k < n; k++) {
      const s = Math.floor(rand() * header.speciesCount);
      const b = HOTSPOTS[s]![0]!;
      const lon = b.lon + (rand() - 0.5) * b.sigma * 2;
      const lat = b.lat + (rand() - 0.5) * b.sigma * 2;
      const rec = at + 4 + k * 12;
      view.setFloat32(rec, lon, true);
      view.setFloat32(rec + 4, lat, true);
      view.setUint16(rec + 8, s + 1, true);
      view.setUint8(rec + 10, Math.floor(rand() * 4));
      view.setUint8(rec + 11, rand() < 0.1 ? SIGHTING_FLAG.duplicate : rand() < 0.05 ? SIGHTING_FLAG.conflict : 0);
      records.push({ lon, lat, taxon: s + 1, frame: f });
    }
    offset = at + 4 + n * 12;
  }
  return { bytes, header, records };
}
