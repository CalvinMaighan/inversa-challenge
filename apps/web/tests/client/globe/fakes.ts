/**
 * Test doubles for the globe: a viewer whose primitive collection is an array, a layer context over plain
 * values, and just enough DOM (canvas, 2D context, the element classes Cesium's Material checks with
 * `instanceof`) for layers to build their primitives under bun. `installDom` returns a restore function.
 */
import { allocFrameGrid, type FrameGrid } from "@calvinjs/active-state/threads";
import * as Cesium from "cesium";

import { setCesium } from "client/globe/cesium";
import { C4_GEOMETRY } from "client/globe/geometry";
import type { GlobeViewer, LayerContext } from "client/globe/layers/types";
import { LAYERS, type LayersState } from "client/state/layers";
import { MISSIONS, type MissionsState } from "client/state/missions";
import type { NotePin } from "client/state/notes";
import type { Peer } from "client/state/peers";
import { TAXA, type TaxaState } from "client/state/taxa";
import type { FrameMeta } from "client/threads/api";
import {
  ENV_MISSING,
  EVF_HEADER_BYTES,
  evfFrameBytes,
  evfFrameLayout,
  SIGHTING_RECORD_BYTES,
  type EvfHeader,
  type SightingRecord,
} from "shared/frames";

export type FakeViewer = GlobeViewer & { added: unknown[]; removed: unknown[] };

export function fakeViewer(): FakeViewer {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  return {
    added,
    removed,
    scene: {
      primitives: {
        add<T>(p: T): T {
          added.push(p);
          return p;
        },
        remove(p: unknown) {
          const i = added.indexOf(p);
          if (i < 0) return false;
          added.splice(i, 1);
          removed.push(p);
          return true;
        },
      },
    },
  };
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly puts: ImageData[] = [];
  getContext(kind: string) {
    if (kind !== "2d") return null;
    const puts = this.puts;
    const noop = () => undefined;
    return new Proxy(
      {
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (image: ImageData) => void puts.push(image),
      } as Record<string, unknown>,
      { get: (target, prop: string) => (prop in target ? target[prop] : noop), set: () => true },
    );
  }
}

export function installDom(): () => void {
  // The browser loads Cesium's prebuilt module; under bun the npm sources stand in.
  setCesium(Cesium);
  const g = globalThis as Record<string, unknown>;
  const names = ["HTMLCanvasElement", "HTMLImageElement", "HTMLVideoElement", "ImageBitmap", "OffscreenCanvas", "document"] as const;
  const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)] as const);
  class Empty {}
  g.HTMLCanvasElement = FakeCanvas;
  g.HTMLImageElement = Empty;
  g.HTMLVideoElement = class {};
  g.ImageBitmap = class {};
  g.OffscreenCanvas = class {};
  // Label measures its font through a detached div and getComputedStyle.
  g.document = {
    createElement: (tag: string) => (tag === "canvas" ? new FakeCanvas() : { style: {} }),
    body: { appendChild: () => undefined, removeChild: () => undefined },
    defaultView: { getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === "font-size" ? "12px" : "normal") }) },
  };
  // GroundPolylinePrimitive validates its line width against WebGL limits, which are zero until a context exists.
  // ContextLimits is exported at runtime but left out of the public typings.
  const limits = (Cesium as unknown as { ContextLimits: Record<string, number> }).ContextLimits;
  const savedLimits = [limits._minimumAliasedLineWidth, limits._maximumAliasedLineWidth];
  limits._minimumAliasedLineWidth = 1;
  limits._maximumAliasedLineWidth = 16;
  return () => {
    limits._minimumAliasedLineWidth = savedLimits[0]!;
    limits._maximumAliasedLineWidth = savedLimits[1]!;
    for (const [n, d] of saved) {
      if (d) Object.defineProperty(g, n, d);
      else delete g[n];
    }
  };
}

export type ContextState = {
  timeMs: number;
  playing: boolean;
  meta: FrameMeta | null;
  sightings: (frame: number) => readonly SightingRecord[];
  revision: number;
  layers: LayersState;
  missions: MissionsState;
  peers: Peer[];
  notes: NotePin[];
  taxa: TaxaState;
  gql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  renders: number;
};

/** C16 meta for `frameCount` frames of `stepMinutes` starting at `frame0UnixMs`, C4 geometry. */
export function fakeMeta(frame0UnixMs: number, frameCount: number, stepMinutes = 60): FrameMeta {
  return { frame0UnixMs, stepMinutes, frameCount, geometry: { ...C4_GEOMETRY } };
}

export function fakeContext(overrides: Partial<ContextState> = {}): LayerContext & { state: ContextState } {
  const state: ContextState = {
    timeMs: Date.parse("2026-09-30T12:00:00Z"),
    playing: false,
    meta: null,
    sightings: () => [],
    revision: 0,
    layers: LAYERS.defaults,
    missions: MISSIONS.defaults,
    peers: [],
    notes: [],
    taxa: TAXA.defaults,
    gql: () => new Promise(() => {}),
    renders: 0,
    ...overrides,
  };
  return {
    state,
    requestRender: () => void (state.renders += 1),
    now: () => 1_000,
    timeMs: () => state.timeMs,
    playing: () => state.playing,
    meta: () => state.meta,
    sightings: (i) => state.sightings(i),
    revision: () => state.revision,
    layers: () => state.layers,
    missions: () => state.missions,
    peers: () => state.peers,
    notes: () => state.notes,
    taxa: () => state.taxa,
    gql: <T>(query: string, variables?: Record<string, unknown>) => state.gql(query, variables) as Promise<T>,
  };
}

/** A small EVF2-shaped grid: C4 sizes, `frames` frames, every env cell valid at 20 °C unless overridden. */
export function smallGrid(frames = 3): FrameGrid {
  const grid = allocFrameGrid({ frameCount: frames, hsCols: 170, hsRows: 160, speciesCount: 4, envCols: 68, envRows: 64, hotspotScale: 1 / 255 });
  for (let f = 0; f < frames; f += 1) {
    grid.lst(f).fill(2000);
    grid.sst(f).fill(ENV_MISSING);
  }
  grid.bump();
  return grid;
}

/** Resolves after pending timers and microtasks up to `ms`. */
export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** [sightingId, lon, lat, taxon, quality, flags] */
export type EvfRec = [number, number, number, number, number, number];
export type EvfTestFrame = { hotspot: number[]; lst: number[]; sst: number[]; sightings: EvfRec[] };

/** Minimal EVF2 writer for the test (the real one is api/src/frames.rs): 16-byte records led by the id. */
export function encodeEvf(h: EvfHeader, frames: EvfTestFrame[]): Uint8Array {
  const size = EVF_HEADER_BYTES + frames.reduce((n, f) => n + evfFrameBytes(h, f.sightings.length), 0);
  const bytes = new Uint8Array(size);
  const v = new DataView(bytes.buffer);
  "EVF2".split("").forEach((ch, i) => v.setUint8(i, ch.charCodeAt(0)));
  v.setUint32(4, h.frameCount, true);
  v.setUint32(8, h.hsCols, true);
  v.setUint32(12, h.hsRows, true);
  v.setFloat64(16, h.west, true);
  v.setFloat64(24, h.south, true);
  v.setFloat64(32, h.hsCellDeg, true);
  v.setBigInt64(40, BigInt(h.frame0UnixMs), true);
  v.setUint32(48, h.stepMinutes, true);
  v.setUint32(52, h.speciesCount, true);
  v.setUint16(56, h.envCols, true);
  v.setUint16(58, h.envRows, true);
  v.setFloat32(60, h.envCellDeg, true);
  v.setFloat32(64, h.hotspotScale, true);
  const layout = evfFrameLayout(h);
  let at = EVF_HEADER_BYTES;
  for (const f of frames) {
    bytes.set(f.hotspot, at);
    f.lst.forEach((c, i) => v.setInt16(at + layout.lstOffset + i * 2, c, true));
    f.sst.forEach((c, i) => v.setInt16(at + layout.sstOffset + i * 2, c, true));
    v.setUint32(at + layout.sightingsOffset, f.sightings.length, true);
    f.sightings.forEach(([id, lon, lat, taxon, quality, flags], k) => {
      const r = at + layout.sightingsOffset + 4 + k * SIGHTING_RECORD_BYTES;
      v.setUint32(r, id, true);
      v.setFloat32(r + 4, lon, true);
      v.setFloat32(r + 8, lat, true);
      v.setUint16(r + 12, taxon, true);
      v.setUint8(r + 14, quality);
      v.setUint8(r + 15, flags);
    });
    at += evfFrameBytes(h, f.sightings.length);
  }
  return bytes;
}
