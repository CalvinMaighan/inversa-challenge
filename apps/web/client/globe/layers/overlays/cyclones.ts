/**
 * Hurricanes and tropical storms (GE5): NHC advisories through `/v1/<app>/overlay/cyclones`, drawn with
 * primitives only: a translucent ground polygon per forecast cone, a grey past track and a white forecast
 * track per storm, small points at the forecast positions, and one larger point with a label at the storm's
 * centre. The centre follows the timeline (`cyclonePositionAt`): scrubbing back slides it along the past
 * fixes, forward along the forecast. Fetched every five minutes while on; the proxy caches upstream for five.
 */
import type { Credit, GroundPrimitive, LabelCollection, PointPrimitiveCollection, PolylineCollection } from "cesium";

import { activeAppId } from "client/state/app";
import { cycloneBucket, cycloneKind, cyclonePositionAt, cyclonesUrl, CYCLONES, overlaySpec, parseCyclones, type Cyclone, type CyclonesDoc } from "shared/overlays";

import { cesium } from "../../cesium";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "../types";

const REFRESH_MS = 5 * 60_000;
export const CYCLONE_ID_PREFIX = "cyclone:";
export const BUCKET_COLORS = { hurricane: "#ff3b30", storm: "#ff9f0a", depression: "#ffd60a" } as const;

/** Storm name with its kind, "Hurricane Rachel · 90 kt". */
export function cycloneLabel(storm: Cyclone): string {
  const wind = storm.intensityKt !== null ? ` · ${storm.intensityKt} kt` : "";
  return `${cycloneKind(storm.classification)} ${storm.name}${wind}`;
}

export function createCyclonesLayer(ctx: LayerContext, load: (url: string, signal: AbortSignal) => Promise<CyclonesDoc> = fetchDoc): GlobeLayer {
  const spec = overlaySpec(CYCLONES);
  let viewer: GlobeViewer | null = null;
  let enabled = false;
  let storms: Cyclone[] = [];
  let loaded = false;
  let fetchedFor = "";
  let cone: GroundPrimitive | null = null;
  let lines: PolylineCollection | null = null;
  let points: PointPrimitiveCollection | null = null;
  let labels: LabelCollection | null = null;
  let credit: Credit | null = null;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drawnKey = "";
  let lastFrame = -1;
  const stats: LayerStats = { id: CYCLONES, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const stopFetching = () => {
    abort?.abort();
    abort = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refetch();
    }, delay);
  };

  const refetch = async () => {
    if (!enabled) return;
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const app = activeAppId();
    try {
      const doc = await load(cyclonesUrl(app), controller.signal);
      if (controller.signal.aborted) return;
      storms = parseCyclones(doc);
      loaded = true;
      fetchedFor = app;
      stats.error = null;
      drawnKey = "";
      draw();
    } catch (err) {
      if (controller.signal.aborted) return;
      stats.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (abort === controller) abort = null;
    }
    if (enabled) schedule(REFRESH_MS);
  };

  const clearPrimitives = () => {
    if (!viewer) return;
    if (cone) viewer.scene.primitives.remove(cone);
    cone = null;
    lines?.removeAll();
    points?.removeAll();
    labels?.removeAll();
  };

  const draw = () => {
    if (!viewer || !enabled || !lines || !points || !labels) return;
    const atMs = ctx.timeMs();
    const key = `${fetchedFor}|${storms.map((s) => `${s.id}:${s.advisory.number}`).join(",")}|${atMs}`;
    if (key === drawnKey) return;
    const C = cesium();
    const { Cartesian2, Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance, LabelStyle, PolygonGeometry, PolygonHierarchy, VerticalOrigin } = C;
    clearPrimitives();
    const cones: InstanceType<typeof GeometryInstance>[] = [];
    for (const storm of storms) {
      const id = `${CYCLONE_ID_PREFIX}${storm.id}`;
      const color = Color.fromCssColorString(BUCKET_COLORS[cycloneBucket(storm.classification)]);
      for (const ring of storm.cone) {
        if (ring.length < 3) continue;
        cones.push(
          new GeometryInstance({
            id,
            geometry: new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(ring.flat())) }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE.withAlpha(0.16)) },
          }),
        );
      }
      if (storm.past.length >= 2) {
        lines.add({ id, positions: Cartesian3.fromDegreesArray(storm.past.flat()), width: 2, material: C.Material.fromType("Color", { color: Color.fromCssColorString("#9aa3ad").withAlpha(0.9) }) });
      }
      if (storm.track.length >= 2) {
        lines.add({ id, positions: Cartesian3.fromDegreesArray(storm.track.flat()), width: 2.5, material: C.Material.fromType("PolylineDash", { color: Color.WHITE.withAlpha(0.95), dashLength: 12 }) });
      }
      for (const p of storm.forecast) {
        points.add({ id, position: Cartesian3.fromDegrees(p.lon, p.lat), pixelSize: 5, color: Color.WHITE.withAlpha(0.9), outlineColor: Color.BLACK.withAlpha(0.6), outlineWidth: 1 });
      }
      const at = cyclonePositionAt(storm, atMs);
      const centre = Cartesian3.fromDegrees(at.lon, at.lat);
      points.add({ id, position: centre, pixelSize: 14, color, outlineColor: Color.WHITE, outlineWidth: 2 });
      labels.add({
        id,
        position: centre,
        text: cycloneLabel(storm),
        font: "600 13px system-ui, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    if (cones.length) {
      cone = viewer.scene.primitives.add(new C.GroundPrimitive({ geometryInstances: cones, appearance: new C.PerInstanceColorAppearance({ flat: true, translucent: true }), show: true }));
    }
    drawnKey = key;
    stats.count = storms.length;
    stats.frame = lastFrame;
    stats.updatedAt = ctx.now();
    stats.breakdown = { storms: storms.length, loaded: loaded ? 1 : 0 };
    stats.overlay = { shownMs: atMs, clamped: null, opacity: 1 };
    ctx.requestRender();
  };

  const setCredit = (on: boolean) => {
    if (!viewer?.creditDisplay) return;
    credit ??= new (cesium().Credit)(spec.credit, true);
    if (on) viewer.creditDisplay.addStaticCredit(credit);
    else viewer.creditDisplay.removeStaticCredit(credit);
  };

  return {
    id: CYCLONES,
    init(v) {
      viewer = v;
      const C = cesium();
      lines = v.scene.primitives.add(new C.PolylineCollection());
      points = v.scene.primitives.add(new C.PointPrimitiveCollection());
      labels = v.scene.primitives.add(new C.LabelCollection());
    },
    enable() {
      enabled = stats.enabled = true;
      setCredit(true);
      if (lines) lines.show = true;
      if (points) points.show = true;
      if (labels) labels.show = true;
      if (cone) cone.show = true;
      // Fresh data for the app on screen; a stale document from another app is never drawn.
      if (!loaded || fetchedFor !== activeAppId()) void refetch();
      else schedule(REFRESH_MS);
    },
    disable() {
      enabled = stats.enabled = false;
      setCredit(false);
      stopFetching();
      if (lines) lines.show = false;
      if (points) points.show = false;
      if (labels) labels.show = false;
      if (cone) cone.show = false;
      ctx.requestRender();
    },
    update(frameIndex) {
      lastFrame = frameIndex;
      if (!enabled) return;
      if (loaded && fetchedFor !== activeAppId()) {
        loaded = false;
        storms = [];
        clearPrimitives();
        void refetch();
        return;
      }
      draw();
    },
    stats: () => ({ ...stats }),
    destroy() {
      stopFetching();
      setCredit(false);
      if (viewer) {
        clearPrimitives();
        if (lines) viewer.scene.primitives.remove(lines);
        if (points) viewer.scene.primitives.remove(points);
        if (labels) viewer.scene.primitives.remove(labels);
      }
      lines = points = labels = null;
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}

async function fetchDoc(url: string, signal: AbortSignal): Promise<CyclonesDoc> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`cyclones: HTTP ${res.status}`);
  return (await res.json()) as CyclonesDoc;
}
