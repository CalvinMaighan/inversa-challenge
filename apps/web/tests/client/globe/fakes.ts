/**
 * Test doubles for the globe: a viewer whose primitive collection is an array, a layer context over plain
 * values, and just enough DOM (canvas, 2D context, the element classes Cesium's Material checks with
 * `instanceof`) for layers to build their primitives under bun. `installDom` returns a restore function.
 */
import { allocFrameGrid, type FrameGrid } from "@calvinjs/active-state/threads";
import * as Cesium from "cesium";

import type { FrameTimeline } from "client/globe/api";
import { setCesium } from "client/globe/cesium";
import type { GlobeViewer, LayerContext } from "client/globe/layers/types";
import { LAYERS, type LayersState } from "client/state/layers";
import { MISSIONS, type MissionsState } from "client/state/missions";
import type { Peer } from "client/state/peers";
import { ENV_MISSING } from "shared/frames";

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
  timeline: FrameTimeline | null;
  layers: LayersState;
  missions: MissionsState;
  peers: Peer[];
  gql: (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
  renders: number;
};

export function fakeContext(overrides: Partial<ContextState> = {}): LayerContext & { state: ContextState } {
  const state: ContextState = {
    timeMs: Date.parse("2026-09-30T12:00:00Z"),
    playing: false,
    timeline: null,
    layers: LAYERS.defaults,
    missions: MISSIONS.defaults,
    peers: [],
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
    timeline: () => state.timeline,
    layers: () => state.layers,
    missions: () => state.missions,
    peers: () => state.peers,
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
