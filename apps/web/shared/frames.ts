/**
 * EVF2 binary frame format (PLAN.md C4). Rust writes (api/src/frames.rs); the db worker
 * and globe layers read. Quantized so 30 days of hourly frames fit in a few MB gzip.
 */

export const EVF_MAGIC = "EVF2";
export const EVF_HEADER_BYTES = 72;
export const SIGHTING_RECORD_BYTES = 16;
/** i16 sentinel for a missing or flagged environment cell. */
export const ENV_MISSING = -32768;

/** Species order in hotspot sections; index + 1 is `taxa.id`. */
export const EVF_SPECIES = ["python", "tegu", "iguana", "lionfish"] as const;

export const QUALITY_CODES = ["research", "needs_id", "casual", "curated"] as const;

export const SIGHTING_FLAG = { duplicate: 1, conflict: 2, late: 4 } as const;

export type EvfHeader = {
  frameCount: number;
  /** Hotspot grid (0.02 deg): 170 x 160 over the C15 bbox. */
  hsCols: number;
  hsRows: number;
  west: number;
  south: number;
  hsCellDeg: number;
  frame0UnixMs: number;
  stepMinutes: number;
  speciesCount: number;
  /** Environment grid (0.05 deg, matches GOES g5 cells): 68 x 64. */
  envCols: number;
  envRows: number;
  envCellDeg: number;
  /** score = u8 * hotspotScale. */
  hotspotScale: number;
};

/**
 * Header layout, little-endian, 72 bytes:
 * 0 magic[4] | 4 frameCount u32 | 8 hsCols u32 | 12 hsRows u32 | 16 west f64 | 24 south f64 |
 * 32 hsCellDeg f64 | 40 frame0UnixMs i64 | 48 stepMinutes u32 | 52 speciesCount u32 |
 * 56 envCols u16 | 58 envRows u16 | 60 envCellDeg f32 | 64 hotspotScale f32 | 68 reserved u32
 *
 * Each frame body, in order:
 *   hotspot u8[speciesCount * hsCols * hsRows] (species-major, row-major from SW corner)
 *   pad to 2 bytes
 *   lst i16[envCols * envRows] (centi-degC; ENV_MISSING = missing/flagged)
 *   sst i16[envCols * envRows]
 *   pad to 4 bytes
 *   sightingCount u32, then records (16 B): u32 sightingId, f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags
 *   (already 4-byte aligned; no trailing pad)
 */
export function readEvfHeader(view: DataView): EvfHeader {
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== EVF_MAGIC) throw new Error(`EVF: bad magic ${JSON.stringify(magic)}`);
  return {
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
    envCellDeg: Math.round(view.getFloat32(60, true) * 1e6) / 1e6,
    hotspotScale: Math.round(view.getFloat32(64, true) * 1e6) / 1e6,
  };
}

const align = (n: number, to: number) => Math.ceil(n / to) * to;

/** Byte offsets of one frame's fixed sections, relative to the frame start. */
export function evfFrameLayout(h: EvfHeader) {
  const hotspotBytes = h.speciesCount * h.hsCols * h.hsRows;
  const envCells = h.envCols * h.envRows;
  const lstOffset = align(hotspotBytes, 2);
  const sstOffset = lstOffset + envCells * 2;
  const sightingsOffset = align(sstOffset + envCells * 2, 4);
  return { hotspotOffset: 0, hotspotBytes, lstOffset, sstOffset, envCells, sightingsOffset };
}

/** Total bytes of a frame given its sighting count. */
export function evfFrameBytes(h: EvfHeader, sightingCount: number): number {
  return evfFrameLayout(h).sightingsOffset + 4 + sightingCount * SIGHTING_RECORD_BYTES;
}

/**
 * Sightings window: the globe draws, the species bar counts and the agent's view means every sighting in the
 * trailing SIGHTING_WINDOW_HOURS ending at the time cursor.
 */
export const SIGHTING_WINDOW_HOURS = 48;

/** One decoded EVF2 sighting record. `id` is `sightings.id`, citable as `sighting:<id>` (C14). */
export type SightingRecord = {
  id: number;
  lon: number;
  lat: number;
  /** `taxa.id`; 1-4 are the focus species in EVF_SPECIES order. */
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
