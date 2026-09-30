/**
 * In-situ stations (USGS gauges, NDBC buoys, CO-OPS tide stations) that reported in the two hours before the
 * cursor: a square billboard per station, tinted by network, carrying the evidence id of its latest reading.
 * Satellite and modelled readings are grid products and belong to the LST/SST rasters, not here.
 */
import type { BillboardCollection } from "cesium";

import { REGION_BBOX } from "client/state/view";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { readingEvidenceId } from "../evidence";
import { bucketOfKey, createKeyedFetch, dataKey } from "./keyed-fetch";
import { createCanvas } from "./raster-surface";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [, , , , STATIONS] = LAYER_IDS;

const LOOKBACK_MS = 2 * 60 * 60_000;
const BUCKET_MS = 15 * 60_000;

/** Window end for the cursor: its 15-minute step, so the marks never include readings after the cursor. */
export function stationBucket(timeMs: number): number {
  return Math.floor(timeMs / BUCKET_MS) * BUCKET_MS;
}
/** Params an in-situ station measures (the GraphQL `Param` enum). */
const IN_SITU_PARAMS = ["AIR_C", "WATER_C", "STAGE_M", "WAVE_M", "RAIN_MM", "WIND_MS"] as const;

export const READINGS_QUERY = `query GlobeStations($bbox: BBox!, $from: Time!, $to: Time!, $params: [Param!]) {
  readings(bbox: $bbox, from: $from, to: $to, params: $params) { param observedAt origin station { id source lat lon } }
}`;

export type GqlReading = {
  param: string;
  observedAt: string;
  origin: string;
  station: { id: string; source: string; lat: number; lon: number };
};

export type StationMark = { stationId: string; source: string; lon: number; lat: number; evidenceId: string };

const SOURCE_COLORS: Record<string, string> = { usgs: "#4fb3ff", ndbc: "#3fd6c6", coops: "#c89bff" };
const OTHER_SOURCE_COLOR = "#e8edf2";

export function stationColor(source: string): string {
  return SOURCE_COLORS[source.toLowerCase()] ?? OTHER_SOURCE_COLOR;
}

/** One mark per station, from its most recent measured reading. */
export function latestPerStation(readings: readonly GqlReading[]): StationMark[] {
  const best = new Map<string, GqlReading>();
  for (const r of readings) {
    if (r.origin.toLowerCase() !== "measured") continue;
    const prev = best.get(r.station.id);
    if (!prev || Date.parse(r.observedAt) > Date.parse(prev.observedAt)) best.set(r.station.id, r);
  }
  return [...best.values()]
    .map((r) => ({
      stationId: r.station.id,
      source: r.station.source,
      lon: r.station.lon,
      lat: r.station.lat,
      evidenceId: readingEvidenceId(r.station.id, r.param, r.observedAt, r.origin),
    }))
    .sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
}

function squareIcon(): HTMLCanvasElement {
  const size = 12;
  const canvas = createCanvas(size, size);
  const g = canvas.getContext("2d");
  if (g) {
    g.fillStyle = "#0b0d12";
    g.fillRect(0, 0, size, size);
    g.fillStyle = "#ffffff";
    g.fillRect(2, 2, size - 4, size - 4);
  }
  return canvas;
}

export function createStationsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let marks: BillboardCollection | null = null;
  let icon: HTMLCanvasElement | null = null;
  let enabled = false;
  let drawnKey = "";
  let lastFrame = -1;
  const stats: LayerStats = { id: STATIONS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const draw = (key: string, stations: readonly StationMark[]) => {
    if (!marks || key === drawnKey) return;
    const { Cartesian3, Color, VerticalOrigin } = cesium();
    icon ??= squareIcon();
    marks.removeAll();
    for (const s of stations) {
      marks.add({
        id: s.evidenceId,
        position: Cartesian3.fromDegrees(s.lon, s.lat),
        image: icon,
        color: Color.fromCssColorString(stationColor(s.source)),
        verticalOrigin: VerticalOrigin.CENTER,
        disableDepthTestDistance: 200_000,
      });
    }
    drawnKey = key;
    stats.count = stations.length;
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    ctx.requestRender();
  };

  const fetcher = createKeyedFetch<StationMark[]>({
    cacheSize: 48,
    load: (key, signal) => {
      const to = bucketOfKey(key);
      return ctx
        .gql<{ readings: GqlReading[] }>(
          READINGS_QUERY,
          { bbox: { ...REGION_BBOX }, from: new Date(to - LOOKBACK_MS).toISOString(), to: new Date(to).toISOString(), params: [...IN_SITU_PARAMS] },
          signal,
        )
        .then((d) => latestPerStation(d.readings));
    },
    onData: (key, stations) => {
      stats.error = null;
      if (enabled && key === dataKey(stationBucket(ctx.timeMs()), ctx)) draw(key, stations);
    },
    onError: (err) => {
      stats.error = err instanceof Error ? err.message : String(err);
    },
  });

  return {
    id: STATIONS,
    init(v) {
      viewer = v;
      marks = v.scene.primitives.add(new (cesium().BillboardCollection)({ show: false }));
    },
    enable() {
      enabled = stats.enabled = true;
      if (marks) marks.show = true;
    },
    disable() {
      enabled = stats.enabled = false;
      fetcher.cancel();
      if (marks) {
        marks.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      if (!enabled) return;
      const key = dataKey(stationBucket(ctx.timeMs()), ctx);
      const stations = fetcher.want(key);
      if (stations) draw(key, stations);
    },
    stats: () => ({ ...stats }),
    destroy() {
      fetcher.cancel();
      if (viewer && marks) viewer.scene.primitives.remove(marks);
      marks = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
