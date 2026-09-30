/**
 * EVF1 binary frame format constants and header codec (PLAN.md C4). Rust writes
 * (api/src/frames.rs); the db worker and globe layers read.
 */

export const EVF_MAGIC = "EVF1";
export const EVF_HEADER_BYTES = 56;
export const SIGHTING_RECORD_BYTES = 12;

/** Species order in hotspot sections; index + 1 is `taxa.id`. */
export const EVF_SPECIES = ["python", "tegu", "iguana", "lionfish"] as const;

export const QUALITY_CODES = ["research", "needs_id", "casual", "curated"] as const;

export const SIGHTING_FLAG = { duplicate: 1, conflict: 2, late: 4 } as const;

export type EvfHeader = {
  frameCount: number;
  cols: number;
  rows: number;
  west: number;
  south: number;
  cellDeg: number;
  frame0UnixMs: number;
  stepMinutes: number;
  speciesCount: number;
};

/**
 * Header layout, little-endian, 56 bytes:
 * 0 magic[4] | 4 frameCount u32 | 8 cols u32 | 12 rows u32 | 16 west f64 | 24 south f64 |
 * 32 cellDeg f64 | 40 frame0UnixMs i64 | 48 stepMinutes u32 | 52 speciesCount u32
 */
export function readEvfHeader(view: DataView): EvfHeader {
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== EVF_MAGIC) throw new Error(`EVF: bad magic ${JSON.stringify(magic)}`);
  return {
    frameCount: view.getUint32(4, true),
    cols: view.getUint32(8, true),
    rows: view.getUint32(12, true),
    west: view.getFloat64(16, true),
    south: view.getFloat64(24, true),
    cellDeg: view.getFloat64(32, true),
    frame0UnixMs: Number(view.getBigInt64(40, true)),
    stepMinutes: view.getUint32(48, true),
    speciesCount: view.getUint32(52, true),
  };
}

/** Bytes of one frame's fixed part (hotspot + lst + sst), before the sighting index. */
export function evfGridBytes(h: EvfHeader): number {
  const cells = h.cols * h.rows;
  return (h.speciesCount + 2) * cells * 4;
}
