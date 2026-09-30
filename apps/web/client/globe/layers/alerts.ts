/**
 * NWS alert polygons in effect at the cursor: a translucent GroundPrimitive fill per alert with a
 * GroundPolylinePrimitive outline, both carrying `alert:<id>`. Fetched through `gqlRequest` per hour bucket.
 */
import type { GeometryInstance, GroundPolylinePrimitive, GroundPrimitive } from "cesium";

import { REGION_BBOX } from "client/state/view";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { alertEvidenceId } from "../evidence";
import { polygonsOf } from "./geojson";
import { createKeyedFetch, type KeyedFetch } from "./keyed-fetch";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [, , , , , ALERTS] = LAYER_IDS;

const HOUR_MS = 60 * 60_000;

export const ALERTS_QUERY = `query GlobeAlerts($bbox: BBox!, $at: Time!) {
  alerts(bbox: $bbox, at: $at) { id event severity areaGeojson }
}`;

export type GqlAlert = { id: string; event: string; severity: string; areaGeojson: unknown };

/** NWS CAP severities. */
const SEVERITY_COLORS: Record<string, string> = {
  extreme: "#d7263d",
  severe: "#f46036",
  moderate: "#f5b700",
  minor: "#58a4b0",
};
const UNKNOWN_SEVERITY_COLOR = "#9aa5b1";

export function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity.toLowerCase()] ?? UNKNOWN_SEVERITY_COLOR;
}

/** Hour bucket start for the cursor; alert validity is coarser than frames. */
export function alertBucket(timeMs: number): number {
  return Math.floor(timeMs / HOUR_MS) * HOUR_MS;
}

export function createAlertsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let fill: GroundPrimitive | null = null;
  let outline: GroundPolylinePrimitive | null = null;
  let enabled = false;
  let drawnKey = "";
  let lastFrame = -1;
  const stats: LayerStats = { id: ALERTS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const clear = () => {
    if (viewer) {
      if (fill) viewer.scene.primitives.remove(fill);
      if (outline) viewer.scene.primitives.remove(outline);
    }
    fill = outline = null;
  };

  const draw = (key: string, alerts: readonly GqlAlert[]) => {
    if (!viewer || key === drawnKey) return;
    const C = cesium();
    const { Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance, GroundPolylineGeometry, PolygonGeometry, PolygonHierarchy } = C;
    clear();
    const fills: GeometryInstance[] = [];
    const lines: GeometryInstance[] = [];
    for (const alert of alerts) {
      const id = alertEvidenceId(alert.id);
      const color = Color.fromCssColorString(severityColor(alert.severity));
      for (const rings of polygonsOf(alert.areaGeojson)) {
        const [outer, ...holes] = rings.map((r) => Cartesian3.fromDegreesArray(r));
        fills.push(
          new GeometryInstance({
            id,
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(outer, holes.map((h) => new PolygonHierarchy(h))),
            }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.2)) },
          }),
        );
        for (const r of [outer!, ...holes]) {
          lines.push(
            new GeometryInstance({
              id,
              geometry: new GroundPolylineGeometry({ positions: r, width: 2, loop: true }),
              attributes: { color: ColorGeometryInstanceAttribute.fromColor(color.withAlpha(0.9)) },
            }),
          );
        }
      }
    }
    if (fills.length) {
      fill = viewer.scene.primitives.add(
        new C.GroundPrimitive({ geometryInstances: fills, appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }), show: enabled }),
      );
      outline = viewer.scene.primitives.add(
        new C.GroundPolylinePrimitive({ geometryInstances: lines, appearance: new C.PolylineColorAppearance(), show: enabled }),
      );
    }
    drawnKey = key;
    stats.count = alerts.length;
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    ctx.requestRender();
  };

  const fetcher: KeyedFetch<GqlAlert[]> = createKeyedFetch({
    cacheSize: 72,
    load: (key, signal) =>
      ctx
        .gql<{ alerts: GqlAlert[] }>(ALERTS_QUERY, { bbox: { ...REGION_BBOX }, at: new Date(Number(key)).toISOString() }, signal)
        .then((d) => d.alerts),
    onData: (key, alerts) => {
      stats.error = null;
      if (enabled && key === String(alertBucket(ctx.timeMs()))) draw(key, alerts);
    },
    onError: (err) => {
      stats.error = err instanceof Error ? err.message : String(err);
    },
  });

  return {
    id: ALERTS,
    init(v) {
      viewer = v;
    },
    enable() {
      enabled = stats.enabled = true;
      if (fill) fill.show = true;
      if (outline) outline.show = true;
    },
    disable() {
      enabled = stats.enabled = false;
      fetcher.cancel();
      if (fill || outline) {
        if (fill) fill.show = false;
        if (outline) outline.show = false;
        ctx.requestRender();
      }
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      if (!enabled) return;
      const key = String(alertBucket(ctx.timeMs()));
      const alerts = fetcher.want(key);
      if (alerts) draw(key, alerts);
    },
    stats: () => ({ ...stats }),
    destroy() {
      fetcher.cancel();
      clear();
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
