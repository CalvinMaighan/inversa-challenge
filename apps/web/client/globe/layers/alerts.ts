/**
 * NWS alert polygons in effect at the cursor: a translucent GroundPrimitive fill per alert with a
 * GroundPolylinePrimitive outline, both carrying `alert:<id>`. Fetched through `gqlRequest` per hour bucket.
 */
import type { GeometryInstance, GroundPolylinePrimitive, GroundPrimitive } from "cesium";

import { activeApp } from "client/state/app";
import { appBBox } from "shared/apps";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { cesium } from "../cesium";
import { alertEvidenceId } from "../evidence";
import { polygonsOf } from "./geojson";
import { bucketOfKey, createKeyedFetch, dataKey, type KeyedFetch } from "./keyed-fetch";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";

const [, , , , , ALERTS] = LAYER_IDS;

const HOUR_MS = 60 * 60_000;
/** Longest wait for new ground primitives before the old ones are dropped anyway. */
const READY_TIMEOUT_MS = 10_000;

export const ALERTS_QUERY = `query GlobeAlerts($bbox: BBox!, $at: Time!) {
  alerts(bbox: $bbox, at: $at) { id event severity headline expires areaGeojson }
}`;

export type GqlAlert = { id: string; event: string; severity: string; headline?: string | null; expires?: string | null; areaGeojson: unknown };

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

/**
 * Instant the alerts of an hour bucket are asked for: its start, except for the bucket holding now (the live
 * edge), which asks at now so a warning issued minutes ago shows before the next hour. The live bucket is
 * refetched whenever the data revision moves, so the instant stays fresh.
 */
export function alertQueryTime(bucketMs: number, nowMs: number): number {
  return nowMs >= bucketMs && nowMs < bucketMs + HOUR_MS ? nowMs : bucketMs;
}

export function createAlertsLayer(ctx: LayerContext): GlobeLayer {
  let viewer: GlobeViewer | null = null;
  let fill: GroundPrimitive | null = null;
  let outline: GroundPolylinePrimitive | null = null;
  let enabled = false;
  let drawnKey = "";
  /** What is drawn (ids and severities): a refetch that returns the same alerts keeps the primitives. */
  let drawnSig = "";
  let lastFrame = -1;
  /** Primitives on their way out, kept until their replacements are ready. */
  let retiring: (GroundPrimitive | GroundPolylinePrimitive)[] = [];
  /** Bumped per swap (and on clear), so only the latest swap retires primitives. */
  let swapGeneration = 0;
  const stats: LayerStats = { id: ALERTS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };
  /** Alerts in effect at the cursor by evidence id, for `describe`. */
  let byId = new Map<string, GqlAlert>();

  const remove =(list: readonly (GroundPrimitive | GroundPolylinePrimitive | null)[]) => {
    if (viewer) for (const p of list) if (p) viewer.scene.primitives.remove(p);
  };
  const clear = () => {
    swapGeneration += 1;
    remove([fill, outline, ...retiring]);
    retiring = [];
    fill = outline = null;
  };

  /**
   * Ground primitives build their geometry asynchronously, and the idle scene renders only on request: keep
   * asking for frames until the new primitives are ready (or `READY_TIMEOUT_MS` passes), then drop the ones
   * they replace, so a refresh neither waits for an unrelated render nor leaves a blank gap.
   */
  const swapWhenReady = (next: readonly (GroundPrimitive | GroundPolylinePrimitive)[]) => {
    const deadline = ctx.now() + READY_TIMEOUT_MS;
    const generation = ++swapGeneration;
    const tick = () => {
      // A newer draw took over; it retires everything this one would have.
      if (generation !== swapGeneration) return;
      const done = next.every((p) => p.ready) || ctx.now() > deadline || typeof requestAnimationFrame !== "function";
      if (done) {
        const old = retiring.filter((p) => !next.includes(p));
        retiring = [];
        remove(old);
      } else {
        requestAnimationFrame(tick);
      }
      ctx.requestRender();
    };
    tick();
  };

  const draw = (key: string, alerts: readonly GqlAlert[]) => {
    if (!viewer || key === drawnKey) return;
    byId = new Map(alerts.map((a) => [alertEvidenceId(a.id), a]));
    const sig = alerts.map((a) => `${a.id}:${a.severity}`).join(",");
    if (sig === drawnSig && (fill || alerts.length === 0)) {
      drawnKey = key;
      stats.frame = lastFrame;
      return;
    }
    const C = cesium();
    const { Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance, GroundPolylineGeometry, PolygonGeometry, PolygonHierarchy } = C;
    retiring.push(...[fill, outline].filter((p): p is GroundPrimitive | GroundPolylinePrimitive => p !== null));
    fill = outline = null;
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
    drawnSig = sig;
    stats.count = alerts.length;
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    swapWhenReady([fill, outline].filter((p): p is GroundPrimitive | GroundPolylinePrimitive => p !== null));
  };

  const fetcher: KeyedFetch<GqlAlert[]> = createKeyedFetch({
    cacheSize: 72,
    load: (key, signal) =>
      ctx
        .gql<{ alerts: GqlAlert[] }>(ALERTS_QUERY, { bbox: appBBox(activeApp()), at: new Date(alertQueryTime(bucketOfKey(key), Date.now())).toISOString() }, signal)
        .then((d) => d.alerts),
    onData: (key, alerts) => {
      stats.error = null;
      if (enabled && key === dataKey(alertBucket(ctx.timeMs()), ctx)) draw(key, alerts);
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
      const key = dataKey(alertBucket(ctx.timeMs()), ctx);
      const alerts = fetcher.want(key);
      if (alerts) draw(key, alerts);
    },
    stats: () => ({ ...stats }),
    describe(id) {
      const a = enabled ? byId.get(id) : undefined;
      if (!a) return null;
      const expires = a.expires ? Date.parse(a.expires) : NaN;
      return { kind: "alert", event: a.event, severity: a.severity, headline: a.headline ?? null, expiresMs: Number.isFinite(expires) ? expires : null };
    },
    destroy() {
      fetcher.cancel();
      clear();
      byId = new Map();
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
