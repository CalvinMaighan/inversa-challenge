/**
 * EVF2 binary frame format (PLAN.md C4). Rust writes (api/src/frames.rs); the db worker
 * and globe layers read. Quantized so 30 days of hourly frames fit in a few MB gzip.
 */

export const EVF_MAGIC = "EVF2";
export const EVF_HEADER_BYTES = 72;
export const SIGHTING_RECORD_BYTES = 12;
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
 *   sightingCount u32, then records: f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags
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
    hotspotScale: view.getFloat32(64, true),
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
