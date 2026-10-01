/**
 * EVF2 binary frame format (PLAN.md C4, C-A4). Rust writes (api/src/frames.rs); the db worker
 * and globe layers read. Quantized so 30 days of hourly frames fit in a few MB gzip.
 * Golden vectors and their expectations: spec/frames/README.md.
 */
import { speciesIds, type AppConfig } from "shared/apps";

export const EVF_MAGIC = "EVF2";
/** Fixed header bytes; a multi-region file adds `EVF_REGION_DESC_BYTES` per region (`evfHeaderBytes`). */
export const EVF_HEADER_BYTES = 72;
export const EVF_REGION_DESC_BYTES = 40;
export const SIGHTING_RECORD_BYTES = 16;
/** i16 sentinel: no reading for this environment cell (outside the product's domain, or nothing reported). */
export const ENV_MISSING = -32768;
/** i16 sentinel: the cell's pixel reported, but flagged (cloud, bad DQF, missing value). A gap to hatch. */
export const ENV_FLAGGED = -32767;

/** A centi-degree environment value, as opposed to either sentinel. */
export function isEnvValue(centi: number): boolean {
  return centi !== ENV_MISSING && centi !== ENV_FLAGGED;
}

/**
 * Species order in an app's hotspot sections: the app's `taxa[]` order (taxon filter keys). Index + 1 is the
 * taxon's `taxa.id` in that app's observations database (C-A4 TaxonIdx).
 */
export function evfSpecies(app: Pick<AppConfig, "taxa">): string[] {
  return speciesIds(app as AppConfig);
}

export const QUALITY_CODES = ["research", "needs_id", "casual", "curated"] as const;

export const SIGHTING_FLAG = { duplicate: 1, conflict: 2, late: 4 } as const;

/** One region's grids: hotspot (2 x the app's cellDeg) and environment (5 x cellDeg), both from the region's SW corner. */
export type EvfRegion = {
  hsCols: number;
  hsRows: number;
  west: number;
  south: number;
  hsCellDeg: number;
  envCols: number;
  envRows: number;
  envCellDeg: number;
};

export type EvfHeader = EvfRegion & {
  frameCount: number;
  frame0UnixMs: number;
  stepMinutes: number;
  speciesCount: number;
  /** score = u8 * hotspotScale. */
  hotspotScale: number;
  /** The app's `regions[]` length. The grid fields above are region 0's. Absent = 1 (hand-built headers). */
  regionCount?: number;
  /** Every region's grids in `regions[]` order; `regions[0]` equals the header's grid fields. Absent = region 0 only. */
  regions?: EvfRegion[];
};

/** Header bytes for `regionCount` regions: descriptors follow only when there are several. */
export function evfHeaderBytes(regionCount: number): number {
  return regionCount > 1 ? EVF_HEADER_BYTES + regionCount * EVF_REGION_DESC_BYTES : EVF_HEADER_BYTES;
}

/** The regions of a header (region 0 from the grid fields when the header carries no table). */
export function evfRegions(h: EvfHeader): EvfRegion[] {
  if (h.regions) return h.regions;
  const { hsCols, hsRows, west, south, hsCellDeg, envCols, envRows, envCellDeg } = h;
  return [{ hsCols, hsRows, west, south, hsCellDeg, envCols, envRows, envCellDeg }];
}

const f32 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Header layout, little-endian, 72 bytes:
 * 0 magic[4] | 4 frameCount u32 | 8 hsCols u32 | 12 hsRows u32 | 16 west f64 | 24 south f64 |
 * 32 hsCellDeg f64 | 40 frame0UnixMs i64 | 48 stepMinutes u32 | 52 speciesCount u32 |
 * 56 envCols u16 | 58 envRows u16 | 60 envCellDeg f32 | 64 hotspotScale f32 | 68 regionCount u32
 *
 * The grid fields describe region 0. When regionCount > 1, one 40-byte descriptor per region follows:
 * 0 hsCols u32 | 4 hsRows u32 | 8 west f64 | 16 south f64 | 24 hsCellDeg f64 | 32 envCols u16 | 34 envRows u16 |
 * 36 envCellDeg f32. A regionCount of 0 (files written before the field existed) reads as 1.
 *
 * Each frame is one region body per region, in region order. A region body, in order:
 *   hotspot u8[speciesCount * hsCols * hsRows] (species-major, row-major from SW corner)
 *   pad to 2 bytes
 *   lst i16[envCols * envRows] (centi-degC from a station inside the cell; ENV_FLAGGED = only flagged
 *     readings there; ENV_MISSING = no reading)
 *   sst i16[envCols * envRows]
 *   pad to 4 bytes
 *   sightingCount u32, then records (16 B): u32 sightingId, f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags
 *   (already 4-byte aligned; no trailing pad). The records are that region's sightings only.
 */
export function readEvfHeader(view: DataView): EvfHeader {
  if (view.byteLength < EVF_HEADER_BYTES) throw new RangeError(`EVF: ${view.byteLength} bytes is shorter than the header`);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== EVF_MAGIC) throw new Error(`EVF: bad magic ${JSON.stringify(magic)}`);
  const base: EvfHeader = {
    frameCount: view.getUint32(4, true),
    hsCols: view.getUint32(8, true),
    hsRows: view.getUint32(12, true),
    west: view.getFloat64(16, true),
    south: view.getFloat64(24, true),
    hsCellDeg: view.getFloat64(32, true),
    frame0UnixMs: Number(view.getBigInt64(40, true)),
    stepMinutes: view.getUint32(48, true),
    speciesCount: view.getUint32(52, true),
    envCols: view.getUint16(56, true),
    envRows: view.getUint16(58, true),
    envCellDeg: f32(view.getFloat32(60, true)),
    hotspotScale: f32(view.getFloat32(64, true)),
  };
  const regionCount = Math.max(1, view.getUint32(68, true));
  if (regionCount === 1) return { ...base, regionCount, regions: evfRegions(base) };
  const need = evfHeaderBytes(regionCount);
  if (view.byteLength < need) throw new RangeError(`EVF: ${view.byteLength} bytes is shorter than the ${regionCount}-region header (${need})`);
  const regions: EvfRegion[] = [];
  for (let r = 0; r < regionCount; r++) {
    const o = EVF_HEADER_BYTES + r * EVF_REGION_DESC_BYTES;
    regions.push({
      hsCols: view.getUint32(o, true),
      hsRows: view.getUint32(o + 4, true),
      west: view.getFloat64(o + 8, true),
      south: view.getFloat64(o + 16, true),
      hsCellDeg: view.getFloat64(o + 24, true),
      envCols: view.getUint16(o + 32, true),
      envRows: view.getUint16(o + 34, true),
      envCellDeg: f32(view.getFloat32(o + 36, true)),
    });
  }
  return { ...base, regionCount, regions };
}

/** Bytes of the header `h` was read from (where frame 0 starts). */
export function evfHeaderLength(h: EvfHeader): number {
  return evfHeaderBytes(evfRegions(h).length);
}

/** Write a header (inverse of `readEvfHeader`); returns the bytes written. */
export function writeEvfHeader(view: DataView, h: EvfHeader): number {
  const regions = evfRegions(h);
  for (let i = 0; i < 4; i++) view.setUint8(i, EVF_MAGIC.charCodeAt(i));
  view.setUint32(4, h.frameCount, true);
  view.setUint32(8, h.hsCols, true);
  view.setUint32(12, h.hsRows, true);
  view.setFloat64(16, h.west, true);
  view.setFloat64(24, h.south, true);
  view.setFloat64(32, h.hsCellDeg, true);
  view.setBigInt64(40, BigInt(h.frame0UnixMs), true);
  view.setUint32(48, h.stepMinutes, true);
  view.setUint32(52, h.speciesCount, true);
  view.setUint16(56, h.envCols, true);
  view.setUint16(58, h.envRows, true);
  view.setFloat32(60, h.envCellDeg, true);
  view.setFloat32(64, h.hotspotScale, true);
  view.setUint32(68, regions.length, true);
  if (regions.length > 1) {
    regions.forEach((r, i) => {
      const o = EVF_HEADER_BYTES + i * EVF_REGION_DESC_BYTES;
      view.setUint32(o, r.hsCols, true);
      view.setUint32(o + 4, r.hsRows, true);
      view.setFloat64(o + 8, r.west, true);
      view.setFloat64(o + 16, r.south, true);
      view.setFloat64(o + 24, r.hsCellDeg, true);
      view.setUint16(o + 32, r.envCols, true);
      view.setUint16(o + 34, r.envRows, true);
      view.setFloat32(o + 36, r.envCellDeg, true);
    });
  }
  return evfHeaderBytes(regions.length);
}

const align = (n: number, to: number) => Math.ceil(n / to) * to;

/** Byte offsets of one region body's fixed sections, relative to the body start (region 0 by default). */
export function evfFrameLayout(h: EvfHeader, region = 0) {
  const r = evfRegions(h)[region];
  if (!r) throw new RangeError(`EVF: region ${region} outside [0, ${evfRegions(h).length})`);
  const hotspotBytes = h.speciesCount * r.hsCols * r.hsRows;
  const envCells = r.envCols * r.envRows;
  const lstOffset = align(hotspotBytes, 2);
  const sstOffset = lstOffset + envCells * 2;
  const sightingsOffset = align(sstOffset + envCells * 2, 4);
  return { hotspotOffset: 0, hotspotBytes, lstOffset, sstOffset, envCells, sightingsOffset };
}

/** Total bytes of one region body (region 0 by default) given its sighting count. For a one-region file, a frame. */
export function evfFrameBytes(h: EvfHeader, sightingCount: number, region = 0): number {
  return evfFrameLayout(h, region).sightingsOffset + 4 + sightingCount * SIGHTING_RECORD_BYTES;
}

/** One region body inside a frame: absolute byte offset, its sighting count and length. */
export type EvfRegionBody = { offset: number; sightingCount: number; byteLength: number };

/** One frame: its region bodies in region order, total sightings and bytes. `regions[0].offset` is the frame start. */
export type EvfFrameRegions = { offset: number; regions: EvfRegionBody[]; sightingCount: number; byteLength: number };

/**
 * Walk the region bodies of the frame starting at `offset`. Throws a RangeError when a sighting count or a body
 * runs past the buffer (a count read from past the end would be garbage).
 */
export function walkEvfFrame(view: DataView, h: EvfHeader, offset: number, frame = 0): EvfFrameRegions {
  const regions: EvfRegionBody[] = [];
  let at = offset;
  let sightingCount = 0;
  const n = evfRegions(h).length;
  for (let r = 0; r < n; r++) {
    const countAt = at + evfFrameLayout(h, r).sightingsOffset;
    if (countAt + 4 > view.byteLength) throw new RangeError(`EVF: frame ${frame} region ${r} truncated at ${countAt}`);
    const count = view.getUint32(countAt, true);
    const byteLength = evfFrameBytes(h, count, r);
    if (at + byteLength > view.byteLength) throw new RangeError(`EVF: frame ${frame} region ${r} needs ${byteLength} bytes at ${at}, have ${view.byteLength - at}`);
    regions.push({ offset: at, sightingCount: count, byteLength });
    sightingCount += count;
    at += byteLength;
  }
  return { offset, regions, sightingCount, byteLength: at - offset };
}

/** Every frame of an EVF2 buffer, walked from the end of the header. */
export function walkEvf(view: DataView, h: EvfHeader = readEvfHeader(view)): EvfFrameRegions[] {
  const out: EvfFrameRegions[] = [];
  let offset = evfHeaderLength(h);
  for (let i = 0; i < h.frameCount; i++) {
    const f = walkEvfFrame(view, h, offset, i);
    out.push(f);
    offset += f.byteLength;
  }
  return out;
}

/** Sighting records of a walked frame, every region's in region order. */
export function readEvfFrameSightings(view: DataView, h: EvfHeader, f: EvfFrameRegions): SightingRecord[] {
  return f.regions.flatMap((b, r) => readSightingRecords(view, b.offset + evfFrameLayout(h, r).sightingsOffset + 4, b.sightingCount));
}

/** The raw 16-byte records of a walked frame, every region's concatenated (a subarray when there is one region). */
export function evfFrameSightingBytes(bytes: Uint8Array, h: EvfHeader, f: EvfFrameRegions): Uint8Array {
  const parts = f.regions.map((b, r) => {
    const start = b.offset + evfFrameLayout(h, r).sightingsOffset + 4;
    return bytes.subarray(start, start + b.sightingCount * SIGHTING_RECORD_BYTES);
  });
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(f.sightingCount * SIGHTING_RECORD_BYTES);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** One region's sections of one frame, decoded for drawing. */
export type EvfRegionFrame = {
  region: EvfRegion;
  /** u8 scores, species-major then row-major from the SW corner; score = u8 * hotspotScale. */
  hotspot: Uint8Array;
  lst: Int16Array;
  sst: Int16Array;
  sightings: SightingRecord[];
};

const i16s = (bytes: Uint8Array, start: number, count: number): Int16Array => {
  const at = bytes.byteOffset + start;
  if (at % 2 === 0) return new Int16Array(bytes.buffer, at, count);
  return new Int16Array(bytes.slice(start, start + count * 2).buffer);
};

/** Region `region` of a walked frame: hotspot, env rasters (views into `bytes` when aligned) and records. */
export function evfRegionFrame(bytes: Uint8Array, h: EvfHeader, f: EvfFrameRegions, region: number): EvfRegionFrame {
  const body = f.regions[region];
  if (!body) throw new RangeError(`EVF: region ${region} outside [0, ${f.regions.length})`);
  const layout = evfFrameLayout(h, region);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    region: evfRegions(h)[region]!,
    hotspot: bytes.subarray(body.offset, body.offset + layout.hotspotBytes),
    lst: i16s(bytes, body.offset + layout.lstOffset, layout.envCells),
    sst: i16s(bytes, body.offset + layout.sstOffset, layout.envCells),
    sightings: readSightingRecords(view, body.offset + layout.sightingsOffset + 4, body.sightingCount),
  };
}

/**
 * Sightings window: the globe draws, the species bar counts and the agent's view means every sighting in the
 * trailing window ending at the time cursor. The length is state (`LAYERS.sightingHours`, T44), one of
 * SIGHTING_WINDOW_OPTIONS; SIGHTING_WINDOW_HOURS is the default. Most people upload sightings a few days after
 * they see them, so 7 days shows the most.
 */
export const SIGHTING_WINDOW_OPTIONS = [48, 168, 720] as const;
export type SightingWindowHours = (typeof SIGHTING_WINDOW_OPTIONS)[number];
export const SIGHTING_WINDOW_HOURS: SightingWindowHours = 168;

/** "2 days", "7 days", "30 days". */
export function windowLabel(hours: number): string {
  const days = hours / 24;
  return Number.isInteger(days) ? `${days} day${days === 1 ? "" : "s"}` : `${hours} hours`;
}

/** One decoded EVF2 sighting record. `id` is `sightings.id`, citable as `sighting:<id>` (C14). */
export type SightingRecord = {
  id: number;
  lon: number;
  lat: number;
  /** `taxa.id`; 1..n are the app's focus species in `evfSpecies(app)` order. */
  taxon: number;
  /** Index into QUALITY_CODES. */
  quality: number;
  /** SIGHTING_FLAG bits. */
  flags: number;
};

/** Decode `count` records starting at `offset` (the byte after the frame's sightingCount). */
export function readSightingRecords(view: DataView, offset: number, count: number): SightingRecord[] {
  const out: SightingRecord[] = new Array(count);
  for (let k = 0; k < count; k++) {
    const o = offset + k * SIGHTING_RECORD_BYTES;
    out[k] = {
      id: view.getUint32(o, true),
      lon: view.getFloat32(o + 4, true),
      lat: view.getFloat32(o + 8, true),
      taxon: view.getUint16(o + 12, true),
      quality: view.getUint8(o + 14),
      flags: view.getUint8(o + 15),
    };
  }
  return out;
}
