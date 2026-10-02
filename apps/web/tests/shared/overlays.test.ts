import { describe, expect, test } from "bun:test";
import path from "node:path";

import { LAYER_IDS } from "shared/apps";
import {
  celsiusToFahrenheit,
  CLOUDS,
  cycloneBucket,
  cycloneKind,
  cyclonePositionAt,
  CYCLONES,
  cyclonesUrl,
  DEFAULT_OVERLAY_OPACITY,
  isOverlayId,
  latestAvailable,
  LIGHTNING,
  OVERLAY_IDS,
  OVERLAYS,
  overlaySpec,
  overlaysForApp,
  overlayTileTemplate,
  overlayTileUrl,
  overlayTimeParam,
  parseCyclones,
  RADAR,
  shownTimeLine,
  snapOverlayTime,
  SST_MAP,
  tempLabel,
  type CyclonesDoc,
} from "shared/overlays";

const FIXTURES = path.join(import.meta.dir, "../../../../api/fixtures/nhc");
const fixture = async (name: string) => Bun.file(path.join(FIXTURES, name)).json();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T19:46:00Z");

describe("overlay catalogue", () => {
  test("overlay catalogue: five overlays, every id a LAYER_ID, SST maps only for the water apps", () => {
    expect(OVERLAY_IDS).toEqual(["sst-map", "radar", "clouds", "lightning", "cyclones"]);
    for (const id of OVERLAY_IDS) expect(LAYER_IDS).toContain(id);
    expect(OVERLAYS.map((o) => o.id)).toEqual([...OVERLAY_IDS]);
    expect(overlaysForApp("python").map((o) => o.id)).toEqual([RADAR, CLOUDS, LIGHTNING, CYCLONES]);
    expect(overlaysForApp("carp").map((o) => o.id)).toEqual([SST_MAP, RADAR, CLOUDS, LIGHTNING, CYCLONES]);
    expect(overlaysForApp("lionfish").map((o) => o.id)).toEqual([SST_MAP, RADAR, CLOUDS, LIGHTNING, CYCLONES]);
    expect(isOverlayId("radar")).toBe(true);
    expect(isOverlayId("sst")).toBe(false);
    expect(DEFAULT_OVERLAY_OPACITY).toBe(0.75);
    // Every overlay speaks plainly and names its source.
    for (const o of OVERLAYS) {
      expect(o.blurb.length).toBeGreaterThan(20);
      expect(o.blurb).not.toMatch(/WMS|WMTS|GeoJSON|dBZ|MRMS/);
      expect(o.attribution).toMatch(/NOAA|NASA/);
      expect(o.sourceUrl).toMatch(/^https:\/\/(gibs\.earthdata\.nasa\.gov|nowcoast\.noaa\.gov|www\.nhc\.noaa\.gov)\//);
    }
    // SST legend carries both units.
    const sst = overlaySpec(SST_MAP).legend;
    expect(sst.kind).toBe("ramp");
    if (sst.kind === "ramp") {
      expect(sst.min).toBe("0 °C / 32 °F");
      expect(sst.max).toBe("32 °C / 90 °F");
      expect(sst.unit).toBe("°C / °F");
    }
    expect(celsiusToFahrenheit(26)).toBe(79);
    expect(tempLabel(30)).toBe("30 °C / 86 °F");
  });

  test("overlay catalogue: tile URLs go through the same-origin proxy with the snapped time, to the minute", () => {
    const at = Date.parse("2026-10-01T19:36:12.345Z");
    expect(overlayTimeParam(at)).toBe("2026-10-01T19:36:12Z");
    expect(overlayTileTemplate("carp", RADAR, at)).toBe("/v1/carp/overlay/radar/{z}/{x}/{y}?time=2026-10-01T19%3A36%3A12Z");
    expect(overlayTileUrl("lionfish", SST_MAP, 6, 17, 27, Date.parse("2026-09-30T00:00:00Z"))).toBe("/v1/lionfish/overlay/sst-map/6/17/27?time=2026-09-30T00%3A00%3A00Z");
    expect(cyclonesUrl("python")).toBe("/v1/python/overlay/cyclones");
  });
});

describe("overlay time", () => {
  test("overlay time: radar snaps to its 4-minute cadence and clamps to what nowCOAST still has", () => {
    const radar = overlaySpec(RADAR);
    expect(radar.cadenceMs).toBe(4 * MIN);
    const latest = latestAvailable(radar, NOW);
    expect(latest).toBe(Date.parse("2026-10-01T19:40:00Z"));
    expect(latest % (4 * MIN)).toBe(0);
    // An arbitrary cursor rounds to the nearest 4 minutes.
    expect(snapOverlayTime(radar, Date.parse("2026-10-01T18:01:30Z"), NOW)).toEqual({ shownMs: Date.parse("2026-10-01T18:00:00Z"), clamped: null });
    expect(snapOverlayTime(radar, Date.parse("2026-10-01T18:02:30Z"), NOW)).toEqual({ shownMs: Date.parse("2026-10-01T18:04:00Z"), clamped: null });
    // The live edge and the future show the newest frame and say so.
    expect(snapOverlayTime(radar, NOW, NOW)).toEqual({ shownMs: latest, clamped: "latest" });
    expect(snapOverlayTime(radar, NOW + DAY, NOW)).toEqual({ shownMs: latest, clamped: "latest" });
    // Thirty days back is beyond the source's window: the oldest kept frame, flagged.
    const old = snapOverlayTime(radar, NOW - 30 * DAY, NOW);
    expect(old.clamped).toBe("earliest");
    expect(latest - old.shownMs).toBe(Math.floor(radar.historyMs / radar.cadenceMs) * radar.cadenceMs);
    expect(old.shownMs % (4 * MIN)).toBe(0);
  });

  test("overlay time: clouds every 5 minutes, lightning every 15, each on its own grid", () => {
    const clouds = overlaySpec(CLOUDS);
    const lightning = overlaySpec(LIGHTNING);
    expect(clouds.cadenceMs).toBe(5 * MIN);
    expect(lightning.cadenceMs).toBe(15 * MIN);
    const t = Date.parse("2026-10-01T18:07:00Z");
    expect(snapOverlayTime(clouds, t, NOW).shownMs).toBe(Date.parse("2026-10-01T18:05:00Z"));
    expect(snapOverlayTime(lightning, t, NOW).shownMs).toBe(Date.parse("2026-10-01T18:00:00Z"));
    expect(snapOverlayTime(lightning, Date.parse("2026-10-01T18:08:00Z"), NOW).shownMs).toBe(Date.parse("2026-10-01T18:15:00Z"));
    // A timeline frame step (15 min) always moves lightning by one frame or none, never two.
    let last = snapOverlayTime(lightning, NOW - 4 * HOUR, NOW).shownMs;
    for (let t2 = NOW - 4 * HOUR + 15 * MIN; t2 < NOW - HOUR; t2 += 15 * MIN) {
      const next = snapOverlayTime(lightning, t2, NOW).shownMs;
      expect(next - last).toBe(15 * MIN);
      last = next;
    }
  });

  test("overlay time: the SST map is daily, snaps to the UTC day and never asks GIBS for a day it has not published", () => {
    const sst = overlaySpec(SST_MAP);
    expect(sst.cadenceMs).toBe(DAY);
    // 2026-10-01 19:46Z: GIBS's default (newest) date was 2026-09-30 (WMTSCapabilities Default, read 2026-10-01).
    expect(latestAvailable(sst, NOW)).toBe(Date.parse("2026-09-30T00:00:00Z"));
    expect(snapOverlayTime(sst, NOW, NOW)).toEqual({ shownMs: Date.parse("2026-09-30T00:00:00Z"), clamped: "latest" });
    expect(snapOverlayTime(sst, Date.parse("2026-09-20T23:59:00Z"), NOW)).toEqual({ shownMs: Date.parse("2026-09-20T00:00:00Z"), clamped: null });
    // Early in the UTC day the day before is not out yet either: two days back.
    expect(latestAvailable(sst, Date.parse("2026-10-01T02:00:00Z"))).toBe(Date.parse("2026-09-29T00:00:00Z"));
  });

  test("overlay time: the legend says which instant is shown and whether it is an edge", () => {
    const radar = overlaySpec(RADAR);
    expect(shownTimeLine(radar, { shownMs: Date.parse("2026-10-01T19:36:00Z"), clamped: null })).toBe("Showing 19:36 UTC, 2026-10-01");
    expect(shownTimeLine(radar, { shownMs: Date.parse("2026-10-01T19:40:00Z"), clamped: "latest" })).toBe("Showing 19:40 UTC, 2026-10-01 (newest available)");
    expect(shownTimeLine(radar, { shownMs: Date.parse("2026-10-01T12:40:00Z"), clamped: "earliest" })).toBe("Showing 12:40 UTC, 2026-10-01 (oldest kept by the source)");
    expect(shownTimeLine(overlaySpec(SST_MAP), { shownMs: Date.parse("2026-09-30T00:00:00Z"), clamped: null })).toBe("Showing 2026-09-30");
  });
});

describe("nhc cyclones", () => {
  async function doc(): Promise<CyclonesDoc> {
    const current = await fixture("CurrentStorms.json");
    const features = [];
    for (const layer of ["points", "track", "cone", "past"]) {
      const fc = (await fixture(`summary-${layer}.geojson`)) as { features: { properties: Record<string, unknown> }[] };
      for (const f of fc.features) features.push({ ...f, properties: { ...f.properties, layer } });
    }
    return { fetchedAt: "2026-10-01T19:52:00Z", current, features: { type: "FeatureCollection", features } };
  }

  test("nhc cyclones: the recorded CurrentStorms.json (2026-10-01) parses to three storms with positions, advisories and geometry", async () => {
    const storms = parseCyclones(await doc());
    expect(storms.map((s) => [s.id, s.name, s.classification])).toEqual([
      ["ep182026", "Rachel", "HU"],
      ["ep192026", "Nineteen-E", "TD"],
      ["ep152026", "Nolo", "TS"],
    ]);
    const rachel = storms[0]!;
    expect(rachel).toMatchObject({ intensityKt: 90, pressureMb: 964, lat: 19.6, lon: -109.6, movementDir: 295, movementKt: 6 });
    expect(rachel.lastUpdateMs).toBe(Date.parse("2026-10-01T15:00:00Z"));
    expect(rachel.advisory).toEqual({ number: "018", issuedMs: Date.parse("2026-10-01T15:00:00Z"), url: "https://www.nhc.noaa.gov/text/MIATCPEP3.shtml" });
    // Geometry matched by bin number: forecast points in tau order with valid times, a track, a cone and a past track.
    expect(rachel.forecast.length).toBeGreaterThanOrEqual(5);
    expect(rachel.forecast[0]).toMatchObject({ tauH: 0, validMs: rachel.advisory.issuedMs, maxWindKt: 90 });
    for (let i = 1; i < rachel.forecast.length; i += 1) expect(rachel.forecast[i]!.tauH).toBeGreaterThan(rachel.forecast[i - 1]!.tauH);
    expect(rachel.track.length).toBeGreaterThanOrEqual(2);
    expect(rachel.cone.length).toBe(1);
    expect(rachel.cone[0]!.length).toBeGreaterThan(50);
    expect(rachel.past.length).toBeGreaterThanOrEqual(4);
    for (const [lon, lat] of [...rachel.track, ...rachel.past, ...rachel.cone[0]!]) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    }
    // Every storm has a position even if its geometry were missing.
    for (const s of storms) expect(Number.isFinite(s.lat) && Number.isFinite(s.lon)).toBe(true);
    expect(cycloneBucket("HU")).toBe("hurricane");
    expect(cycloneBucket("TS")).toBe("storm");
    expect(cycloneBucket("TD")).toBe("depression");
    expect(cycloneKind("HU")).toBe("Hurricane");
    expect(cycloneKind("PTC")).toBe("Potential tropical cyclone");
  });

  test("nhc cyclones: no active storms parses to none; a malformed document to none, never a throw", async () => {
    expect(parseCyclones({ fetchedAt: "x", current: { activeStorms: [] }, features: { type: "FeatureCollection", features: [] } })).toEqual([]);
    expect(parseCyclones({ fetchedAt: "x", current: null, features: null })).toEqual([]);
    expect(parseCyclones({ fetchedAt: "x", current: { activeStorms: [{ id: "x" }] }, features: {} })).toEqual([]);
    // Positions without geometry: a storm that the MapServer has not caught up with.
    const current = await fixture("CurrentStorms.json");
    const bare = parseCyclones({ fetchedAt: "x", current, features: { type: "FeatureCollection", features: [] } });
    expect(bare.length).toBe(3);
    expect(bare[0]!.forecast).toEqual([]);
    expect(bare[0]!.cone).toEqual([]);
  });

  test("nhc cyclones: the centre follows the timeline, back along the fixes and forward along the forecast", async () => {
    const rachel = parseCyclones(await doc())[0]!;
    const now = cyclonePositionAt(rachel, rachel.lastUpdateMs);
    expect(now).toEqual({ lon: rachel.lon, lat: rachel.lat, phase: "now" });
    const f1 = rachel.forecast[1]!;
    const ahead = cyclonePositionAt(rachel, f1.validMs!);
    expect(ahead.phase).toBe("forecast");
    expect(ahead.lon).toBeCloseTo(f1.lon, 6);
    expect(ahead.lat).toBeCloseTo(f1.lat, 6);
    const mid = cyclonePositionAt(rachel, (rachel.lastUpdateMs + f1.validMs!) / 2);
    expect(mid.lon).toBeCloseTo((rachel.lon + f1.lon) / 2, 6);
    const back = cyclonePositionAt(rachel, rachel.lastUpdateMs - 6 * HOUR);
    expect(back.phase).toBe("past");
    const prev = rachel.past[rachel.past.length - 1]!;
    expect(back.lon).toBeCloseTo(prev[0], 6);
    expect(back.lat).toBeCloseTo(prev[1], 6);
    const start = cyclonePositionAt(rachel, rachel.lastUpdateMs - 365 * DAY);
    expect([start.lon, start.lat]).toEqual(rachel.past[0]!);
    const far = cyclonePositionAt(rachel, rachel.lastUpdateMs + 30 * DAY);
    const last = rachel.forecast[rachel.forecast.length - 1]!;
    expect([far.lon, far.lat]).toEqual([last.lon, last.lat]);
  });
});
