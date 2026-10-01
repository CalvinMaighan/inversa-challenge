import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import path from "node:path";
import * as Cesium from "cesium";
import type { GroundPrimitive, ImageryLayer, LabelCollection, PointPrimitiveCollection, PolylineCollection } from "cesium";

import { createLayers } from "client/globe/layers";
import { layerClock } from "client/globe/layers/clock";
import { createCyclonesLayer, cycloneLabel, createOverlayRasterLayer, overlayOpacity, setOverlayOpacity } from "client/globe/layers/overlays";
import { activeAttributions, overlayRows, rampCss } from "client/globe/layers/overlays/legend";
import type { LayerStats } from "client/globe/layers/types";
import { set } from "@calvinjs/active-state";

import { applyApp } from "client/state/app-switch";
import { CARP } from "client/state/carp";
import { layersFor } from "client/state/layers";
import { getApp, LAYER_IDS } from "shared/apps";
import { CLOUDS, CYCLONES, DEFAULT_OVERLAY_OPACITY, LIGHTNING, OVERLAY_IDS, overlaySpec, RADAR, SST_MAP, type CyclonesDoc } from "shared/overlays";

import { fakeContext, fakeViewer, flush, installDom, type FakeViewer } from "./fakes";

selectPython();

let restore: () => void;
beforeAll(() => {
  restore = installDom();
});
afterAll(() => {
  restore();
  selectPython();
});

const FIXTURES = path.join(import.meta.dir, "../../../../../api/fixtures/nhc");
const MIN = 60_000;

/** A viewer with a Cesium-shaped imagery layer stack and a credit display, both recorded. */
function imageryViewer(): FakeViewer & { imagery: ImageryLayer[]; credits: string[] } {
  const base = fakeViewer();
  const imagery: ImageryLayer[] = [];
  const credits: string[] = [];
  return Object.assign(base, {
    imagery,
    credits,
    scene: {
      ...base.scene,
      imageryLayers: {
        add(layer: unknown) {
          imagery.push(layer as ImageryLayer);
        },
        remove(layer: unknown) {
          const i = imagery.indexOf(layer as ImageryLayer);
          if (i < 0) return false;
          imagery.splice(i, 1);
          return true;
        },
      },
    },
    creditDisplay: {
      addStaticCredit: (c: unknown) => void credits.push((c as { html: string }).html),
      removeStaticCredit: (c: unknown) => void credits.splice(credits.indexOf((c as { html: string }).html), 1),
    },
  });
}

const onLayers = (ids: readonly string[]) => {
  const state = layersFor(getApp("python"));
  for (const id of ids) state.visible[id as (typeof LAYER_IDS)[number]] = true;
  return state;
};

async function fixtureDoc(): Promise<CyclonesDoc> {
  const current = await Bun.file(path.join(FIXTURES, "CurrentStorms.json")).json();
  const features = [];
  for (const layer of ["points", "track", "cone", "past"]) {
    const fc = (await Bun.file(path.join(FIXTURES, `summary-${layer}.geojson`)).json()) as { features: { properties: Record<string, unknown> }[] };
    for (const f of fc.features) features.push({ ...f, properties: { ...f.properties, layer } });
  }
  return { fetchedAt: "2026-10-01T19:52:00Z", current, features: { type: "FeatureCollection", features } };
}

describe("overlay layers", () => {
  test("overlay layers: the five overlays are in createLayers, after the classic nine, and default off in every app", () => {
    const layers = createLayers(fakeContext());
    expect(layers.slice(-5).map((l) => l.id)).toEqual([...OVERLAY_IDS]);
    for (const app of ["carp", "lionfish", "python"] as const) {
      const state = layersFor(getApp(app));
      for (const id of OVERLAY_IDS) expect(state.visible[id]).toBe(false);
    }
    // Before init every overlay reports the plain contract shape, nothing extra.
    for (const layer of layers.slice(-5)) expect(layer.stats()).toEqual({ id: layer.id, enabled: false, count: 0, frame: -1, updatedAt: null, error: null });
  });

  test("overlay time: a raster overlay adds one imagery layer at the snapped time, swaps it when the time changes and reports what it shows", async () => {
    const t0 = Date.parse("2026-10-01T18:00:00Z");
    const ctx = fakeContext({ timeMs: t0, layers: onLayers([RADAR]) });
    const viewer = imageryViewer();
    const layer = createOverlayRasterLayer(RADAR, ctx);
    layer.init(viewer);
    layer.update(3, null);
    expect(viewer.imagery.length).toBe(0); // off: no work
    layer.enable();
    expect(viewer.credits).toEqual([overlaySpec(RADAR).credit]);
    layer.update(3, null);
    expect(viewer.imagery.length).toBe(1);
    const stats = layer.stats();
    expect(stats.count).toBe(1);
    expect(stats.frame).toBe(3);
    expect(stats.error).toBeNull();
    expect(stats.overlay?.opacity).toBe(DEFAULT_OVERLAY_OPACITY);
    const shown = stats.overlay!.shownMs;
    expect(shown % (4 * MIN)).toBe(0);
    expect(Math.abs(shown - t0)).toBeLessThanOrEqual(2 * MIN);
    const url = (viewer.imagery[0] as unknown as { imageryProvider: { url: string } }).imageryProvider.url;
    expect(url).toBe(`/v1/python/overlay/radar/{z}/{x}/{y}?time=${encodeURIComponent(new Date(shown).toISOString().replace(".000Z", "Z"))}`);
    expect((viewer.imagery[0] as ImageryLayer).alpha).toBe(DEFAULT_OVERLAY_OPACITY);
    // Same snapped time: no new layer. One cadence step later: a new layer over the old, old retires shortly.
    layer.update(3, null);
    expect(viewer.imagery.length).toBe(1);
    ctx.state.timeMs = t0 + 4 * MIN;
    layer.update(4, null);
    expect(viewer.imagery.length).toBe(2);
    expect(layer.stats().overlay!.shownMs).toBe(shown + 4 * MIN);
    await flush(800);
    expect(viewer.imagery.length).toBe(1);
    // The opacity slider reaches the live layer.
    setOverlayOpacity(0.4);
    expect(overlayOpacity()).toBe(0.4);
    expect((viewer.imagery[0] as ImageryLayer).alpha).toBe(0.4);
    expect(layer.stats().overlay!.opacity).toBe(0.4);
    setOverlayOpacity(DEFAULT_OVERLAY_OPACITY);
    // Far past: clamped to the oldest frame and flagged; far future: the newest.
    ctx.state.timeMs = t0 - 30 * 24 * 60 * MIN;
    layer.update(5, null);
    expect(layer.stats().overlay!.clamped).toBe("earliest");
    ctx.state.timeMs = Date.now() + 60 * MIN;
    layer.update(6, null);
    expect(layer.stats().overlay!.clamped).toBe("latest");
    // Off: the stack is cleared, the credit withdrawn, the shown time gone.
    layer.disable();
    await flush(800);
    expect(viewer.imagery.length).toBe(0);
    expect(viewer.credits).toEqual([]);
    expect(layer.stats().overlay).toBeUndefined();
    expect(layer.stats().count).toBe(0);
    layer.destroy();
    expect(ctx.state.renders).toBeGreaterThan(0);
  });

  test("overlay time: each raster overlay snaps to its own cadence and the SST map asks for a UTC day", () => {
    // Two hours ago, on the hour, plus 7 minutes: inside every source's window on the wall clock.
    const base = Math.floor((Date.now() - 2 * 60 * MIN) / (60 * MIN)) * 60 * MIN;
    const t = base + 7 * MIN;
    const ctx = fakeContext({ timeMs: t, layers: onLayers([SST_MAP, CLOUDS, LIGHTNING]) });
    const shown: Record<string, number> = {};
    for (const id of [SST_MAP, CLOUDS, LIGHTNING] as const) {
      const viewer = imageryViewer();
      const layer = createOverlayRasterLayer(id, ctx);
      layer.init(viewer);
      layer.enable();
      layer.update(0, null);
      shown[id] = layer.stats().overlay!.shownMs;
      const url = (viewer.imagery[0] as unknown as { imageryProvider: { url: string; maximumLevel: number } }).imageryProvider;
      expect(url.url.startsWith(`/v1/python/overlay/${id}/{z}/{x}/{y}?time=`)).toBe(true);
      expect(url.maximumLevel).toBe(overlaySpec(id).maxZoom!);
      layer.destroy();
    }
    // The SST day: the UTC day of the cursor, unless that day is not published yet (then the newest one).
    const day = 24 * 60 * MIN;
    expect(shown[SST_MAP]).toBe(Math.min(Math.floor(t / day) * day, Math.floor((Date.now() - 36 * 60 * MIN) / day) * day));
    expect(shown[CLOUDS]).toBe(base + 5 * MIN);
    expect(shown[LIGHTNING]).toBe(base);
  });

  test("overlay time: in carp the overlays follow the stage chart's 'what we knew' cursor (CARP.asOf), live when unset", async () => {
    applyApp("carp");
    const base = Math.floor((Date.now() - 2 * 60 * MIN) / (60 * MIN)) * 60 * MIN;
    // The viewer's clock (GE7): carp's cursor is CARP.asOf, now (here base + 60 min) when live.
    const ctx = { ...fakeContext({ layers: onLayers([RADAR]) }), ...layerClock(() => base + 60 * MIN) };
    const viewer = imageryViewer();
    const layer = createOverlayRasterLayer(RADAR, ctx);
    layer.init(viewer);
    layer.enable();
    set(CARP, { asOf: base + 7 * MIN });
    layer.update(0, null);
    expect(layer.stats().overlay!.shownMs).toBe(base + 8 * MIN);
    // The cursor moves without a TIME change: the viewer refreshes the layers on CARP as on TIME.
    set(CARP, { asOf: base + 30 * MIN });
    layer.update(0, null);
    expect(layer.stats().overlay!.shownMs).toBe(base + 32 * MIN);
    // Live again: now.
    set(CARP, {});
    layer.update(0, null);
    expect(layer.stats().overlay!.shownMs).toBe(base + 60 * MIN);
    layer.destroy();
    await flush(800);
    applyApp("python");
  });

  test("overlay layers: a viewer without imagery layers (the plain fake) reports an error instead of throwing", () => {
    const ctx = fakeContext({ layers: onLayers([RADAR]) });
    const layer = createOverlayRasterLayer(RADAR, ctx);
    layer.init(fakeViewer());
    layer.enable();
    layer.update(0, null);
    expect(layer.stats().error).toBe("imagery layers unavailable");
    expect(layer.stats().count).toBe(0);
    layer.destroy();
  });

  test("nhc cyclones: the layer draws a cone, tracks, forecast points and a labelled centre per storm from the recorded feed, and moves the centre with the timeline", async () => {
    const doc = await fixtureDoc();
    const asked: string[] = [];
    const load = async (url: string) => {
      asked.push(url);
      return doc;
    };
    const t0 = Date.parse("2026-10-01T15:00:00Z");
    const ctx = fakeContext({ timeMs: t0, layers: onLayers([CYCLONES]) });
    const viewer = imageryViewer();
    const layer = createCyclonesLayer(ctx, load);
    layer.init(viewer);
    layer.update(0, null); // off: nothing fetched
    expect(asked).toEqual([]);
    layer.enable();
    expect(viewer.credits).toEqual([overlaySpec(CYCLONES).credit]);
    await flush(20);
    expect(asked).toEqual(["/v1/python/overlay/cyclones"]);
    layer.update(1, null);
    const stats = layer.stats();
    expect(stats.count).toBe(3);
    expect(stats.breakdown).toEqual({ storms: 3, loaded: 1 });
    expect(stats.error).toBeNull();
    expect(stats.overlay?.shownMs).toBe(t0);
    const lines = viewer.added.find((p) => p instanceof Cesium.PolylineCollection) as PolylineCollection;
    const points = viewer.added.find((p) => p instanceof Cesium.PointPrimitiveCollection) as PointPrimitiveCollection;
    const labels = viewer.added.find((p) => p instanceof Cesium.LabelCollection) as LabelCollection;
    const cone = viewer.added.find((p) => p instanceof Cesium.GroundPrimitive) as GroundPrimitive | undefined;
    expect(cone).toBeDefined();
    expect(labels.length).toBe(3);
    expect(labels.get(0).text).toBe("Hurricane Rachel · 90 kt");
    expect(cycloneLabel({ name: "Nolo", classification: "TS", intensityKt: null } as never)).toBe("Tropical storm Nolo");
    // Past and forecast tracks per storm, forecast points plus one centre per storm.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(points.length).toBeGreaterThan(3);
    /** Rachel's centre: the first storm's large point is the first centre added (forecast points first, then the centre). */
    const rachelCentre = () => {
      const big = [];
      for (let i = 0; i < points.length; i += 1) if (points.get(i).pixelSize === 14) big.push(points.get(i));
      const c = Cesium.Cartographic.fromCartesian(big[0]!.position);
      return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
    };
    expect(rachelCentre().lon).toBeCloseTo(-109.6, 3);
    expect(rachelCentre().lat).toBeCloseTo(19.6, 3);
    // Scrub forward 12 h: the centre moves along the forecast (a different draw key, redrawn).
    ctx.state.timeMs = t0 + 12 * 60 * MIN;
    layer.update(2, null);
    expect(layer.stats().overlay?.shownMs).toBe(t0 + 12 * 60 * MIN);
    expect(layer.stats().frame).toBe(2);
    expect(rachelCentre().lon).not.toBeCloseTo(-109.6, 3);
    // Off hides, on shows again without a refetch; destroy removes everything.
    layer.disable();
    expect(lines.show).toBe(false);
    expect(viewer.credits).toEqual([]);
    layer.enable();
    await flush(20);
    expect(asked.length).toBe(1);
    layer.destroy();
    expect(viewer.added.filter((p) => p === lines || p === points || p === labels).length).toBe(0);
  });

  test("nhc cyclones: a failed fetch is an error on the row, an empty feed is zero storms (loaded), and an app switch refetches", async () => {
    let fail = true;
    const asked: string[] = [];
    const load = async (url: string) => {
      asked.push(url);
      if (fail) throw new Error("cyclones: HTTP 502");
      return { fetchedAt: "x", current: { activeStorms: [] }, features: { type: "FeatureCollection", features: [] } } as CyclonesDoc;
    };
    const ctx = fakeContext({ layers: onLayers([CYCLONES]) });
    const layer = createCyclonesLayer(ctx, load);
    layer.init(imageryViewer());
    layer.enable();
    await flush(20);
    expect(layer.stats().error).toBe("cyclones: HTTP 502");
    expect(layer.stats().breakdown).toBeUndefined();
    layer.disable();
    fail = false;
    layer.enable();
    await flush(20);
    layer.update(0, null);
    expect(layer.stats()).toMatchObject({ count: 0, error: null, breakdown: { storms: 0, loaded: 1 } });
    // Another app: its own feed URL.
    applyApp("carp");
    layer.update(1, null);
    await flush(20);
    expect(asked.at(-1)).toBe("/v1/carp/overlay/cyclones");
    applyApp("python");
    layer.destroy();
  });
});

describe("water and weather", () => {
  test("water and weather: rows for the app's overlays with blurbs, units, shown time, storm note and attribution of the ones that are on", () => {
    const app = getApp("lionfish");
    const stats: LayerStats[] = [
      { id: RADAR, enabled: true, count: 1, frame: 2, updatedAt: 1, error: null, overlay: { shownMs: Date.parse("2026-10-01T19:36:00Z"), clamped: "latest", opacity: 0.75 } },
      { id: CYCLONES, enabled: true, count: 0, frame: 2, updatedAt: 1, error: null, breakdown: { storms: 0, loaded: 1 } },
      { id: CLOUDS, enabled: true, count: 0, frame: 2, updatedAt: null, error: "tiles failed" },
    ];
    const layers = layersFor(app);
    layers.visible[RADAR] = true;
    layers.visible[CYCLONES] = true;
    layers.visible[CLOUDS] = true;
    const rows = overlayRows(app, layers, stats);
    expect(rows.map((r) => r.id)).toEqual([SST_MAP, RADAR, CLOUDS, LIGHTNING, CYCLONES]);
    expect(rows.map((r) => r.visible)).toEqual([false, true, true, false, true]);
    const radar = rows[1]!;
    expect(radar.label).toBe("Rain radar");
    expect(radar.blurb).toBe("Where it is raining now.");
    expect(radar.shown).toBe("Showing 19:36 UTC, 2026-10-01 (newest available)");
    expect(rows[4]!.note).toBe("No active storms");
    expect(rows[2]!.error).toBe("tiles failed");
    expect(rows[0]!.shown).toBeNull();
    const sst = rows[0]!.legend;
    expect(sst.kind === "ramp" && sst.min === "0 °C / 32 °F" && sst.max === "32 °C / 90 °F").toBe(true);
    if (sst.kind === "ramp") expect(rampCss(sst)).toMatch(/^linear-gradient\(90deg, #2c0b7a 0%, .* 100%\)$/);
    expect(activeAttributions(rows).map((a) => a.attribution)).toEqual([overlaySpec(RADAR).attribution, overlaySpec(CLOUDS).attribution, overlaySpec(CYCLONES).attribution]);
    // Python lists no SST map.
    expect(overlayRows(getApp("python"), layersFor(getApp("python")), null).map((r) => r.id)).toEqual([RADAR, CLOUDS, LIGHTNING, CYCLONES]);
    expect(activeAttributions(overlayRows(getApp("python"), layersFor(getApp("python")), null))).toEqual([]);
  });
});
