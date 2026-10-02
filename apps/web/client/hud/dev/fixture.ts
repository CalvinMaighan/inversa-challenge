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
import { V1_APP } from "client/state/app";
import { getApp } from "shared/apps";
import {
  ENV_MISSING,
  EVF_HEADER_BYTES,
  evfFrameBytes,
  evfFrameLayout,
  evfSpecies,
  readEvfFrameSightings,
  readEvfHeader,
  SIGHTING_FLAG,
  SIGHTING_RECORD_BYTES,
  walkEvf,
  writeEvfHeader,
  type EvfHeader,
  type SightingRecord,
} from "shared/frames";

import { C4_BBOX } from "client/globe/geometry";
import type { FrameSightings } from "client/threads/api";

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

/** The fixture is the python app's (one South Florida region, its one taxon), hotspot planes in `taxa[]` order. */
const SPECIES = evfSpecies(getApp(V1_APP));

/** Hotspot centres per species id. */
const HOTSPOTS: Readonly<Record<string, Blob[]>> = {
  python: [
    { lon: -80.9, lat: 25.55, sigma: 0.22, peak: 1 },
    { lon: -81.25, lat: 25.95, sigma: 0.14, peak: 0.7 },
  ],
  lionfish: [{ lon: -81.05, lat: 24.68, sigma: 0.18, peak: 0.9 }],
};
const blobsOf = (s: number): Blob[] => HOTSPOTS[SPECIES[s]!] ?? [];

const inside = (f: number, [s, e]: readonly [number, number]) => f >= s && f < e;

/** Fixture sighting ids start here; the fixture's primed evidence uses ids below it. */
export const FIXTURE_FIRST_SIGHTING_ID = 100_000;

export type FixtureSighting = SightingRecord & { frame: number };
export type Fixture = { bytes: Uint8Array; header: EvfHeader; records: FixtureSighting[] };

export function buildFixtureEvf(frame0Ms: number, frames = FIXTURE_FRAMES, seed = 7): Fixture {
  const rand = mulberry32(seed);
  const header: EvfHeader = {
    frameCount: frames,
    hsCols: 170,
    hsRows: 160,
    west: C4_BBOX.west,
    south: C4_BBOX.south,
    hsCellDeg: 0.02,
    frame0UnixMs: frame0Ms,
    stepMinutes: FIXTURE_STEP_MINUTES,
    speciesCount: SPECIES.length,
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

  writeEvfHeader(view, header);

  const envLand = new Uint8Array(header.envCols * header.envRows);
  for (let r = 0; r < header.envRows; r++) {
    for (let c = 0; c < header.envCols; c++) {
      envLand[r * header.envCols + c] = isLand(header.west + (c + 0.5) * header.envCellDeg, header.south + (r + 0.5) * header.envCellDeg) ? 1 : 0;
    }
  }

  const records: FixtureSighting[] = [];
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
          for (const b of blobsOf(s)) {
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

    // Sightings near a species hotspot, 16-byte records: u32 id, f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags.
    const at = offset + layout.sightingsOffset;
    const n = counts[f]!;
    view.setUint32(at, n, true);
    for (let k = 0; k < n; k++) {
      const s = Math.floor(rand() * header.speciesCount);
      const b = blobsOf(s)[0] ?? { lon: (header.west + C4_BBOX.east) / 2, lat: (header.south + C4_BBOX.north) / 2, sigma: 0.1, peak: 1 };
      const record: FixtureSighting = {
        id: FIXTURE_FIRST_SIGHTING_ID + records.length,
        lon: Math.fround(b.lon + (rand() - 0.5) * b.sigma * 2),
        lat: Math.fround(b.lat + (rand() - 0.5) * b.sigma * 2),
        taxon: s + 1,
        quality: Math.floor(rand() * 4),
        flags: rand() < 0.1 ? SIGHTING_FLAG.duplicate : rand() < 0.05 ? SIGHTING_FLAG.conflict : 0,
        frame: f,
      };
      const rec = at + 4 + k * SIGHTING_RECORD_BYTES;
      view.setUint32(rec, record.id, true);
      view.setFloat32(rec + 4, record.lon, true);
      view.setFloat32(rec + 8, record.lat, true);
      view.setUint16(rec + 12, record.taxon, true);
      view.setUint8(rec + 14, record.quality);
      view.setUint8(rec + 15, record.flags);
      records.push(record);
    }
    offset = at + 4 + n * SIGHTING_RECORD_BYTES;
  }
  return { bytes, header, records };
}

/**
 * Walk an EVF2 buffer (PLAN.md C4): each frame's byte offset and sighting count. Frames vary in length (the
 * sighting section), so this is the only way to find frame `i`. Throws on a truncated buffer: a count read
 * from past the end would be garbage, and a silent zero would draw a false quiet gap.
 */
export function evfFrames(bytes: Uint8Array): { header: EvfHeader; offsets: Uint32Array; counts: Uint32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readEvfHeader(view);
  const frames = walkEvf(view, header);
  return {
    header,
    offsets: Uint32Array.from(frames, (f) => f.offset),
    counts: Uint32Array.from(frames, (f) => f.sightingCount),
  };
}

/** The sighting sections of an EVF2 buffer as `FrameSightings` (PLAN.md C16), the way the db worker publishes them. */
export function evfFrameSightings(bytes: Uint8Array): FrameSightings {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readEvfHeader(view);
  const frames = walkEvf(view, header);
  const counts = Uint32Array.from(frames, (f) => f.sightingCount);
  return {
    counts,
    records(i) {
      if (!Number.isInteger(i) || i < 0 || i >= counts.length) throw new RangeError(`frame ${i} out of range`);
      return readEvfFrameSightings(view, header, frames[i]!);
    },
  };
}
