import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { allocFrameGrid } from "@calvinjs/active-state/threads";
import type { BillboardCollection, GroundPrimitive, LabelCollection, PointPrimitiveCollection } from "cesium";

import { createLayers } from "client/globe/layers";
import { alertBucket } from "client/globe/layers/alerts";
import { createHotspotLayer } from "client/globe/layers/hotspots";
import { createMissionsLayer, MISSION_ID_PREFIX, missionMark } from "client/globe/layers/missions";
import { createPeersLayer, cursorPeers } from "client/globe/layers/peers";
import { createSightingsLayer, SIGHTING_TRAIL_MS, trailAlpha, trailFromFrames, visibleRecords } from "client/globe/layers/sightings";
import { createStationsLayer, latestPerStation, stationBreakdown, stationBucket } from "client/globe/layers/stations";
import { createLstLayer } from "client/globe/layers/env-raster";
import type { GlobeLayer } from "client/globe/layers/types";
import { LAYERS } from "client/state/layers";
import { MISSIONS } from "client/state/missions";
import { ENV_MISSING, SIGHTING_FLAG, type SightingRecord } from "shared/frames";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { fakeContext, fakeMeta, fakeViewer, flush, installDom, smallGrid } from "./fakes";

let restore: () => void;
beforeAll(() => {
  restore = installDom();
});
afterAll(() => restore());

const STEP = 60 * 60_000;
const T0 = Date.parse("2026-09-30T00:00:00Z");

const rec = (over: Partial<SightingRecord> = {}): SightingRecord => ({ id: 1, lon: -80.9, lat: 25.6, taxon: 1, quality: 0, flags: 0, ...over });

describe("layer contract", () => {
  test("every LAYER_ID has exactly one layer, in draw order rasters → areas → points → people", () => {
    const layers = createLayers(fakeContext());
    expect(layers.map((l) => l.id).sort()).toEqual([...LAYER_IDS].sort());
    expect(layers.map((l) => l.id)).toEqual(["lst", "sst", "hotspots", "alerts", "stations", "sightings", "missions", "peers"]);
  });

  test("init / enable / update / disable / stats / destroy on a fake viewer, for all eight layers", async () => {
    const ctx = fakeContext({ timeMs: T0 + 2 * STEP, meta: fakeMeta(T0, 3), sightings: () => [rec()] });
    const viewer = fakeViewer();
    const grid = smallGrid(3);
    grid.hotspot(2, 0)[100] = 255;
    const layers = createLayers(ctx);
    for (const layer of layers) {
      const before = layer.stats();
      expect(before).toEqual({ id: layer.id, enabled: false, count: 0, frame: -1, updatedAt: null, error: null });
      layer.init(viewer);
      layer.update(2, grid); // disabled: no work
      expect(layer.stats().frame).toBe(-1);
      layer.enable();
      expect(layer.stats().enabled).toBe(true);
      layer.update(2, grid);
      layer.update(2, grid); // idempotent
      layer.disable();
      expect(layer.stats().enabled).toBe(false);
    }
    await flush();
    const primitives = viewer.added.length;
    expect(primitives).toBeGreaterThan(0);
    // Primitives only: nothing on the fake viewer is an Entity or a DataSource.
    for (const p of viewer.added) expect((p as object).constructor.name).not.toMatch(/Entity|DataSource/);
    for (const layer of layers) layer.destroy();
    expect(viewer.added).toEqual([]);
    expect(viewer.removed.length).toBe(primitives);
  });
});

describe("hotspot heatmap", () => {
  test("paints the frame, repaints in place on frame change, and picks a C14 hotspot id", () => {
    const ctx = fakeContext({ meta: fakeMeta(T0, 3) });
    const viewer = fakeViewer();
    const grid = smallGrid(3);
    // Cell (col 20, row 30) of the 0.02° grid: python 40 in frame 1, iguana 200 in frame 1.
    grid.hotspot(1, 0)[30 * 170 + 20] = 40;
    grid.hotspot(1, 2)[30 * 170 + 20] = 200;
    const layer = createHotspotLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(0, grid);
    expect(layer.stats().count).toBe(0);
    const surface = viewer.added.find((p) => (p as GroundPrimitive).constructor.name === "GroundPrimitive") as GroundPrimitive;
    expect(surface).toBeDefined();
    const renders = ctx.state.renders;
    layer.update(1, grid);
    expect(layer.stats()).toMatchObject({ count: 1, frame: 1 });
    expect(viewer.added.length).toBe(1); // same primitive, repainted
    expect(ctx.state.renders).toBe(renders + 1);
    expect(surface.show).toBe(true);

    const lon = -83.2 + 20.5 * 0.02;
    const lat = 24.3 + 30.5 * 0.02;
    // The C14 cell is on the 0.01° grid; the id carries frame 1's start.
    expect(layer.pickAt!(lon, lat)).toBe(`hotspot:iguana:${Math.floor(20.5 * 2)}:${Math.floor(30.5 * 2)}:${T0 + STEP}`);
    // With iguana filtered out, python's 40 (above the display floor) is what is under the cursor.
    ctx.state.layers = { ...LAYERS.defaults, species: { ...LAYERS.defaults.species, iguana: false } };
    layer.update(1, grid);
    expect(layer.pickAt!(lon, lat)).toMatch(/^hotspot:python:/);
    expect(layer.pickAt!(-90, 10)).toBeNull();
    layer.disable();
    expect(surface.show).toBe(false);
    expect(layer.pickAt!(lon, lat)).toBeNull();
  });

  test("a sub-grid is placed and picked by the FrameMeta geometry", () => {
    const meta = { ...fakeMeta(T0, 1), geometry: { west: -80.5, south: 25.2, hsCellDeg: 0.02, envCellDeg: 0.05 } };
    const ctx = fakeContext({ meta });
    const grid = allocFrameGrid({ frameCount: 1, hsCols: 10, hsRows: 5, speciesCount: 4, envCols: 4, envRows: 2, hotspotScale: 0.01 });
    grid.hotspot(0, 3)[1 * 10 + 4] = 180;
    const layer = createHotspotLayer(ctx);
    layer.init(fakeViewer());
    layer.enable();
    layer.update(0, grid);
    expect(layer.stats().count).toBe(1);
    expect(layer.pickAt!(-80.41, 25.23)).toBe(`hotspot:lionfish:279:93:${T0}`);
    expect(layer.pickAt!(-80.43, 25.23)).toBeNull();
  });

  test("no grid or no frame hides the raster", () => {
    const ctx = fakeContext();
    const viewer = fakeViewer();
    const layer = createHotspotLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(-1, null);
    expect(viewer.added.length).toBe(0);
    const grid = smallGrid(2);
    grid.hotspot(0, 1)[0] = 255;
    layer.update(0, grid);
    expect(layer.stats().count).toBe(1);
    layer.update(-1, grid);
    expect(layer.stats().count).toBe(0);
    expect((viewer.added[0] as GroundPrimitive).show).toBe(false);
  });

  test("a republished grid repaints even at the same frame and version", () => {
    const ctx = fakeContext({ meta: fakeMeta(T0, 1) });
    const layer = createHotspotLayer(ctx);
    layer.init(fakeViewer());
    layer.enable();
    const a = smallGrid(1);
    layer.update(0, a);
    const b = smallGrid(1);
    b.hotspot(0, 0)[0] = 255;
    ctx.state.revision += 1;
    layer.update(0, b);
    expect(layer.stats().count).toBe(1);
  });
});

describe("LST raster", () => {
  test("counts valid cells, leaves never-valid cells out", () => {
    const ctx = fakeContext();
    const viewer = fakeViewer();
    const grid = smallGrid(2);
    grid.lst(1).fill(ENV_MISSING, 0, 100);
    const layer = createLstLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(1, grid);
    expect(layer.stats()).toMatchObject({ count: 68 * 64 - 100, frame: 1 });
    layer.update(0, grid);
    expect(layer.stats().count).toBe(68 * 64);
  });
});

describe("sightings", () => {
  test("trail: 24 h of frames, aged by whole frames", () => {
    const trail = trailFromFrames((f) => [rec({ id: f, taxon: (f % 4) + 1 })], 5, STEP);
    expect(trail.length).toBe(6);
    expect(trail.map((r) => r.ageMs)).toEqual([0, 1, 2, 3, 4, 5].map((n) => n * STEP));
    const long = trailFromFrames(() => [rec()], 500, STEP);
    expect(long.length).toBe(SIGHTING_TRAIL_MS / STEP);
    expect(trailFromFrames(() => [rec()], 500, 15 * 60_000).length).toBe(96);
    expect(trailAlpha(0)).toBe(1);
    expect(trailAlpha(SIGHTING_TRAIL_MS)).toBeCloseTo(0.25);
  });

  test("duplicates hidden, species filter applied, other taxa always shown", () => {
    const records = [rec(), rec({ flags: SIGHTING_FLAG.duplicate }), rec({ taxon: 3 }), rec({ taxon: 42 })].map((r) => ({ ...r, ageMs: 0 }));
    expect(visibleRecords(records, [0]).map((r) => r.taxon)).toEqual([1, 42]);
  });

  test("draws the frame's records as points plus focus-species icons, each carrying sighting:<id>", () => {
    const ctx = fakeContext({
      meta: fakeMeta(T0, 4),
      sightings: (f) => (f === 3 ? [rec({ id: 4_000_123 }), rec({ id: 77, taxon: 99 })] : f === 2 ? [rec({ id: 5, taxon: 4 })] : []),
    });
    const viewer = fakeViewer();
    const layer = createSightingsLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(3, smallGrid(4));
    const [points, icons] = viewer.added as [PointPrimitiveCollection, BillboardCollection];
    expect(points.length).toBe(3); // frame 3 plus frame 2 in the trail
    expect(icons.length).toBe(2); // taxon 99 is not a focus species
    expect([0, 1, 2].map((i) => points.get(i).id)).toEqual(["sighting:4000123", "sighting:77", "sighting:5"]);
    expect(icons.get(0).id).toBe("sighting:4000123");
    expect(layer.stats()).toMatchObject({ count: 3, frame: 3, error: null });
  });

  test("no frame (outside the grid) or no meta clears the dots; no network is used", () => {
    let calls = 0;
    const ctx = fakeContext({
      meta: fakeMeta(T0, 2),
      sightings: () => [rec()],
      gql: async () => {
        calls += 1;
        return {};
      },
    });
    const viewer = fakeViewer();
    const layer = createSightingsLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(1, smallGrid(2));
    expect(layer.stats().count).toBe(2);
    layer.update(-1, smallGrid(2));
    expect(layer.stats().count).toBe(0);
    expect((viewer.added[0] as PointPrimitiveCollection).length).toBe(0);
    ctx.state.meta = null;
    layer.update(1, null);
    expect(layer.stats().count).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("alerts", () => {
  test("fetches the hour bucket, builds fill and outline primitives, one request per bucket", async () => {
    const calls: Record<string, unknown>[] = [];
    const square = { type: "Polygon", coordinates: [[[-80.5, 25.5], [-80.4, 25.5], [-80.4, 25.6], [-80.5, 25.6], [-80.5, 25.5]]] };
    const ctx = fakeContext({
      timeMs: Date.parse("2026-09-30T12:34:00Z"),
      gql: async (_q, vars) => {
        calls.push(vars!);
        return { alerts: [{ id: "urn:1", event: "Freeze Warning", severity: "Severe", areaGeojson: square }] };
      },
    });
    const viewer = fakeViewer();
    const layers = createLayers(ctx);
    const alerts = layers.find((l) => l.id === "alerts")!;
    alerts.init(viewer);
    alerts.enable();
    alerts.update(0, null);
    alerts.update(0, null);
    await flush();
    expect(calls).toEqual([{ bbox: { west: -83.2, south: 24.3, east: -79.8, north: 27.5 }, at: "2026-09-30T12:00:00.000Z" }]);
    expect(viewer.added.map((p) => (p as object).constructor.name)).toEqual(["GroundPrimitive", "GroundPolylinePrimitive"]);
    expect(alerts.stats().count).toBe(1);
    ctx.state.timeMs += 10 * 60_000; // same hour
    alerts.update(0, null);
    expect(calls.length).toBe(1);
    expect(alertBucket(Date.parse("2026-09-30T12:59:59Z"))).toBe(Date.parse("2026-09-30T12:00:00Z"));
  });

  test("an API error is reported in stats and not retried every frame", async () => {
    let calls = 0;
    const ctx = fakeContext({
      gql: async () => {
        calls += 1;
        throw new Error("graphql http 502");
      },
    });
    const layer = createLayers(ctx).find((l) => l.id === "alerts")!;
    layer.init(fakeViewer());
    layer.enable();
    layer.update(0, null);
    await flush();
    layer.update(0, null);
    layer.update(0, null);
    await flush();
    expect(calls).toBe(1);
    expect(layer.stats().error).toBe("graphql http 502");
  });
});

describe("stations", () => {
  test("latest measured reading per station becomes its evidence id", () => {
    const station = { id: "8723970", source: "coops", lat: 24.71, lon: -81.1 };
    const marks = latestPerStation([
      { param: "WATER_C", observedAt: "2026-09-30T10:00:00Z", origin: "MEASURED", station },
      { param: "AIR_C", observedAt: "2026-09-30T11:00:00Z", origin: "MEASURED", station },
      { param: "AIR_C", observedAt: "2026-09-30T11:30:00Z", origin: "MODELED", station },
    ]);
    expect(marks).toEqual([
      {
        stationId: "8723970",
        source: "coops",
        name: "8723970",
        lon: -81.1,
        lat: 24.71,
        param: "AIR_C",
        value: null,
        observedAtMs: Date.parse("2026-09-30T11:00:00Z"),
        evidenceId: `reading:8723970:air_c:${Date.parse("2026-09-30T11:00:00Z")}:measured`,
      },
    ]);
    expect(stationBucket(Date.parse("2026-09-30T11:44:00Z"))).toBe(Date.parse("2026-09-30T11:30:00Z"));
  });

  test("draws one billboard per station with the reading id", async () => {
    const ctx = fakeContext({
      gql: async () => ({
        readings: [{ param: "STAGE_M", observedAt: "2026-09-30T11:00:00Z", origin: "MEASURED", station: { id: "usgs-1", source: "usgs", lat: 25.6, lon: -80.7 } }],
      }),
    });
    const viewer = fakeViewer();
    const layer = createStationsLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(0, null);
    await flush();
    const marks = viewer.added[0] as BillboardCollection;
    expect(marks.length).toBe(1);
    expect(marks.get(0).id).toMatch(/^reading:usgs-1:stage_m:\d+:measured$/);
  });

  test("describe() answers from the drawn mark; stats split by network", async () => {
    const observedAt = "2026-09-30T11:00:00Z";
    const ctx = fakeContext({
      gql: async () => ({
        readings: [
          { param: "STAGE_M", value: 1.21, observedAt, origin: "MEASURED", station: { id: "usgs-1", source: "usgs", name: "Shark River", lat: 25.6, lon: -80.7 } },
          { param: "WATER_C", value: 24.5, observedAt, origin: "MEASURED", station: { id: "ndbc-1", source: "ndbc", name: "Fowey Rocks", lat: 25.59, lon: -80.1 } },
        ],
      }),
    });
    const layer = createStationsLayer(ctx);
    layer.init(fakeViewer());
    layer.enable();
    layer.update(0, null);
    await flush();
    const id = `reading:usgs-1:stage_m:${Date.parse(observedAt)}:measured`;
    expect(layer.describe?.(id)).toEqual({ kind: "station", source: "usgs", name: "Shark River", param: "STAGE_M", value: 1.21, observedAtMs: Date.parse(observedAt), lon: -80.7, lat: 25.6 });
    expect(layer.describe?.("reading:nope:stage_m:1:measured")).toBeNull();
    expect(layer.stats().breakdown).toEqual({ usgs: 1, ndbc: 1, coops: 0, other: 0 });
    expect(stationBreakdown([{ source: "USGS" }, { source: "wmo" }])).toEqual({ usgs: 1, ndbc: 0, coops: 0, other: 1 });
    layer.disable();
    expect(layer.describe?.(id)).toBeNull();
  });
});

describe("missions", () => {
  test("missionMark reads lon/lat or a hotspot cell; deleted or unplaced missions are skipped", () => {
    expect(missionMark({ id: "m1", fields: { lon: -80.5, lat: 25.4, title: "Sweep L-67", status: "active" } })).toEqual({
      id: "m1",
      lon: -80.5,
      lat: 25.4,
      title: "Sweep L-67",
      status: "active",
    });
    const fromCell = missionMark({ id: "m2", fields: { cell: "10:20" } })!;
    expect(fromCell.lon).toBeCloseTo(-83.2 + 0.105);
    expect(fromCell.lat).toBeCloseTo(24.3 + 0.205);
    expect(fromCell.title).toBe("m2");
    expect(missionMark({ id: "m3", fields: { title: "nowhere" } })).toBeNull();
    expect(missionMark({ id: "m4", fields: { lon: -80, lat: 25, _deleted: true } })).toBeNull();
    expect(missionMark({ id: "m5", fields: null })).toBeNull();
  });

  test("refetches the board when MISSIONS.lastSeq moves; focused mission draws larger", async () => {
    const asked: unknown[] = [];
    const ctx = fakeContext({
      gql: async (_q, vars) => {
        asked.push(vars);
        return { board: { missions: [{ id: "m1", fields: { lon: -80.5, lat: 25.4, title: "A" } }, { id: "m2", fields: { lon: -80.6, lat: 25.3, title: "B" } }] } };
      },
    });
    const viewer = fakeViewer();
    const layer = createMissionsLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(0, null);
    await flush();
    const [marks, labels] = viewer.added as [BillboardCollection, LabelCollection];
    expect(marks.length).toBe(2);
    expect(labels.length).toBe(2);
    expect(marks.get(0).id).toBe(`${MISSION_ID_PREFIX}m1`);
    ctx.state.missions = { ...MISSIONS.defaults, focusedMissionId: "m2" };
    layer.update(0, null);
    expect(marks.get(1).scale).toBe(1.5);
    ctx.state.missions = { ...ctx.state.missions, lastSeq: 9 };
    layer.update(0, null);
    await flush();
    expect(asked).toEqual([{ id: "everglades" }, { id: "everglades" }]);
  });
});

describe("peers", () => {
  const now = Date.now();
  const peer = (id: string, over: Partial<{ seenAt: string; cursor: { lon: number; lat: number } | null; link: "open" | "closed" }> = {}) => ({
    peerId: id,
    callsign: `Ranger-${id}`,
    color: "#4fb3ff",
    seenAt: new Date(now - 1_000).toISOString(),
    cursor: { lon: -80.4, lat: 25.5 },
    link: "open" as const,
    ...over,
  });

  test("live peers with a cursor get a dot and a callsign", () => {
    const peers = [peer("a"), peer("b", { cursor: null }), peer("c", { seenAt: new Date(now - 120_000).toISOString() }), peer("d", { link: "closed" })];
    expect(cursorPeers(peers, now).map((p) => p.peerId)).toEqual(["a"]);
    const ctx = fakeContext({ peers });
    const viewer = fakeViewer();
    const layer: GlobeLayer = createPeersLayer(ctx);
    layer.init(viewer);
    layer.enable();
    layer.update(0, null);
    const [dots, labels] = viewer.added as [PointPrimitiveCollection, LabelCollection];
    expect(dots.length).toBe(1);
    expect(labels.get(0).text).toBe("Ranger-a");
    layer.disable();
    expect(dots.show).toBe(false);
    layer.destroy();
  });
});
