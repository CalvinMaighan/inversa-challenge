/**
 * Deterministic EVF2 encoder for tests and the e2e stub (PLAN.md C4 layout, `shared/frames.ts` doc comment).
 * Cell values are a function of (frame, species, cell) so a test can predict what a grid should hold.
 */
import { ENV_MISSING, EVF_HEADER_BYTES, SIGHTING_RECORD_BYTES, evfFrameLayout, type EvfHeader } from "shared/frames";

export type FixtureOptions = {
  frame0UnixMs: number;
  stepMinutes: number;
  frameCount: number;
  hsCols?: number;
  hsRows?: number;
  envCols?: number;
  envRows?: number;
  speciesCount?: number;
  hotspotScale?: number;
  sightingsPerFrame?: number;
  /** Shifts every value, so two fixtures for the same frames can be told apart. */
  salt?: number;
};

export const FIXTURE_DEFAULTS = { hsCols: 8, hsRows: 6, envCols: 4, envRows: 3, speciesCount: 4, hotspotScale: 1 / 256, sightingsPerFrame: 2, salt: 0 } as const;

export function fixtureHeader(o: FixtureOptions): EvfHeader {
  const d = { ...FIXTURE_DEFAULTS, ...o };
  return {
    frameCount: d.frameCount,
    hsCols: d.hsCols,
    hsRows: d.hsRows,
    west: -83.2,
    south: 24.3,
    hsCellDeg: 0.02,
    frame0UnixMs: d.frame0UnixMs,
    stepMinutes: d.stepMinutes,
    speciesCount: d.speciesCount,
    envCols: d.envCols,
    envRows: d.envRows,
    envCellDeg: 0.05,
    hotspotScale: d.hotspotScale,
  };
}

export const hotspotValue = (frame: number, species: number, cell: number, salt = 0): number => (frame * 13 + species * 7 + cell + salt) % 256;
export const lstValue = (frame: number, cell: number, salt = 0): number => (cell % 5 === 4 ? ENV_MISSING : 2000 + frame * 10 + cell + salt);
export const sstValue = (frame: number, cell: number, salt = 0): number => 2500 + frame * 3 + cell * 2 + salt;
/** Sighting id of record `i` in frame `f`: unique across a fixture. */
export const sightingId = (frame: number, i: number): number => 100_000 + frame * 1_000 + i;

export function encodeEvf2(o: FixtureOptions): Uint8Array {
  const h = fixtureHeader(o);
  const d = { ...FIXTURE_DEFAULTS, ...o };
  const layout = evfFrameLayout(h);
  const frameBytes = layout.sightingsOffset + 4 + d.sightingsPerFrame * SIGHTING_RECORD_BYTES;
  const out = new Uint8Array(EVF_HEADER_BYTES + h.frameCount * frameBytes);
  const view = new DataView(out.buffer);
  out.set([0x45, 0x56, 0x46, 0x32], 0);
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
  view.setUint32(68, 1, true); // regionCount: one region

  const hsCells = h.hsCols * h.hsRows;
  for (let f = 0; f < h.frameCount; f++) {
    const base = EVF_HEADER_BYTES + f * frameBytes;
    for (let s = 0; s < h.speciesCount; s++) {
      for (let c = 0; c < hsCells; c++) out[base + s * hsCells + c] = hotspotValue(f, s, c, d.salt);
    }
    for (let c = 0; c < layout.envCells; c++) {
      view.setInt16(base + layout.lstOffset + c * 2, lstValue(f, c, d.salt), true);
      view.setInt16(base + layout.sstOffset + c * 2, sstValue(f, c, d.salt), true);
    }
    view.setUint32(base + layout.sightingsOffset, d.sightingsPerFrame, true);
    for (let i = 0; i < d.sightingsPerFrame; i++) {
      const p = base + layout.sightingsOffset + 4 + i * SIGHTING_RECORD_BYTES;
      view.setUint32(p, sightingId(f, i), true);
      view.setFloat32(p + 4, -80.5 + i * 0.1, true);
      view.setFloat32(p + 8, 25.2 + f * 0.01, true);
      view.setUint16(p + 12, (i % h.speciesCount) + 1, true);
      out[p + 14] = i % 4;
      out[p + 15] = f % 2 === 0 ? 0 : 4;
    }
  }
  return out;
}
