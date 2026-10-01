import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import type { BillboardCollection, PolylineCollection } from "cesium";

import { layerClock } from "client/globe/layers/clock";
import { createVesselsLayer, trailThirds, vesselBucket, vesselWindow, VESSELS_QUERY } from "client/globe/layers/vessels";
import { plainSummary } from "client/hud/drawer/summary";
import { legendRows } from "client/hud/legend/model";
import { applyApp } from "client/state/app-switch";
import { applyCarpView } from "client/state/carp";
import { layersFor } from "client/state/layers";
import { parseEvidenceId } from "client/state/selection";
import { externalLinkProps } from "shared/links";
import { getApp, LAYER_IDS } from "shared/apps";
import { publisherOf } from "shared/source-pages";
import { uiToolsFor } from "@/server/voice/voice-prompt";
import {
  parseTracks,
  positionAt,
  trailAt,
  VESSEL_CREDIT,
  VESSEL_HOLD_MS,
  vesselCard,
  vesselEvidenceId,
  vesselPageUrl,
  type GqlVesselTrack,
} from "shared/vessels";

import { fakeContext, fakeViewer, flush, installDom } from "./fakes";

const MIN = 60_000;
const NOW = Date.now();
/**
 * A past time on the minute, inside the 30-day "what we knew" range, and in the middle of a data bucket so the
 * tests that move the cursor by minutes never cross a bucket boundary (which depended on the time of day).
 */
const T = vesselBucket(NOW - 6 * 3_600_000) + 3 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A tug heading east along 29.5 N, one fix every 10 min from T - 60 min to T + 60 min, 10 kn. */
const TUG: GqlVesselTrack = {
  mmsi: "367123450",
  name: "MISS LOUISE",
  type: "tug",
  points: Array.from({ length: 13 }, (_, i) => ({ at: iso(T + (i - 6) * 10 * MIN), lat: 29.5, lon: -90.5 + i * 0.03, sog: 10, cog: 90, heading: 90 })),
};
/** An anchored tanker. */
const TANKER: GqlVesselTrack = { mmsi: "538006783", name: null, type: "tanker", points: [{ at: iso(T - 5 * MIN), lat: 29.2, lon: -89.9, sog: 0, cog: null, heading: null }] };

let restore: () => void;
beforeAll(() => {
  restore = installDom();
});
afterAll(() => {
  restore();
  selectPython();
});

describe("vessels layer: track maths", () => {
  const [tug] = parseTracks([TUG]);

  test("vessels layer: positions interpolate between fixes, hold briefly after the last, and never invent a past", () => {
    const at = positionAt(tug!, T + 5 * MIN)!;
    expect(at.lat).toBeCloseTo(29.5, 9);
    expect(at.lon).toBeCloseTo(-90.5 + 6 * 0.03 + 0.015, 9);
    expect(Math.round(at.course!)).toBe(90);
    expect(positionAt(tug!, T - 61 * MIN)).toBeNull();
    const last = Date.parse(TUG.points.at(-1)!.at);
    expect(positionAt(tug!, last + VESSEL_HOLD_MS)!.lon).toBeCloseTo(-90.5 + 12 * 0.03, 9);
    expect(positionAt(tug!, last + VESSEL_HOLD_MS + 1)).toBeNull();
    // A 3 h silence is not bridged: the ship holds, then disappears.
    const [gap] = parseTracks([{ ...TUG, points: [TUG.points[0]!, { ...TUG.points[1]!, at: iso(Date.parse(TUG.points[0]!.at) + 180 * MIN) }] }]);
    expect(positionAt(gap!, Date.parse(TUG.points[0]!.at) + 90 * MIN)).toBeNull();
    const [anchored] = parseTracks([TANKER]);
    expect(positionAt(anchored!, T)!.course).toBeNull();
  });

  test("vessels layer: the trail covers the last three hours, ends at the ship, and splits into fading thirds", () => {
    const t = T + 5 * MIN;
    const trail = trailAt(tug!, t);
    expect(trail.at(-1)!.at).toBe(t);
    expect(trail[0]!.at).toBe(T - 60 * MIN);
    expect(trail.length).toBe(8);
    // A shorter trail stops at its start.
    expect(trailAt(tug!, t, 30 * MIN).map((p) => p.at)).toEqual([T - 20 * MIN, T - 10 * MIN, T, t]);
    // An hour of history fills only the newest third of a three-hour trail.
    expect(trailThirds(trail, t).map((r) => r.length)).toEqual([0, 0, 8]);
    const thirds = trailThirds(trail, t, 60 * MIN);
    expect(thirds.map((r) => r.length >= 2)).toEqual([true, true, true]);
    // Each third starts where the previous one ended.
    expect(thirds[1]![0]).toEqual(thirds[0]!.at(-1)!);
    expect(thirds[2]!.at(-1)).toEqual(trail.at(-1)!);
  });

  test("vessels layer: buckets and fetch windows stay inside the API's 7-day cap", () => {
    const b = vesselBucket(T);
    expect(b).toBeLessThanOrEqual(T);
    const w = vesselWindow(b, NOW);
    expect(w.from).toBeLessThan(b - 60 * MIN);
    expect(w.to - w.from).toBeLessThanOrEqual(7 * 24 * 60 * MIN);
  });
});

describe("vessels layer: config, legend and card", () => {
  test("vessels layer: default off, listed for carp and lionfish only, under Ships in the legend", () => {
    expect(LAYER_IDS).toContain("vessels");
    for (const id of ["carp", "lionfish"] as const) {
      const app = getApp(id);
      expect(app.layers.find((l) => l.id === "vessels")?.defaultOn).toBe(false);
      expect(layersFor(app).visible.vessels).toBe(false);
      const row = legendRows(layersFor(app), null, app).find((r) => r.layer === "vessels")!;
      expect(row.group).toBe("Ships");
      expect(row.note).toContain(VESSEL_CREDIT);
      expect(row.swatches.map((s) => s.key)).toContain("vessel-tanker");
      expect(app.feeds.some((f) => f.source === "aisstream" && f.mode === "push")).toBe(true);
    }
    const python = getApp("python");
    expect(python.layers.some((l) => l.id === "vessels")).toBe(false);
    expect(legendRows(layersFor(python), null, python).some((r) => r.layer === "vessels")).toBe(false);
    const toggle = uiToolsFor(python).find((t) => t.name === "toggle_layer")!;
    expect(JSON.stringify(toggle.parameters)).not.toContain("vessels");
  });

  test("vessels layer: the evidence card names the ship, its type, speed and course, and links VesselFinder in a new tab", () => {
    const record = { mmsi: "538006783", name: "FEDERAL OSHIMA", type: "cargo", typeLabel: "Cargo ship", destination: "DETROIT", lastSeen: iso(T), lastPosition: { at: iso(T), lat: 42.3, lon: -83.08, sogKnots: 11.6, cogDeg: 91.4 } };
    expect(vesselCard(record)).toEqual({ title: "FEDERAL OSHIMA", parts: ["Cargo ship", "11.6 kn", "course 91°", "bound for DETROIT"] });
    const summary = plainSummary("vessel", record, T + 2 * MIN)!;
    expect(summary.title).toBe("FEDERAL OSHIMA");
    expect(summary.line).toContain("11.6 kn");
    expect(summary.line).toContain("last heard");
    expect(vesselCard({ mmsi: "1", type: "unknown", lastPosition: { sogKnots: 0 } })).toEqual({ title: "MMSI 1", parts: ["Type not reported", "stopped"] });
    expect(parseEvidenceId(vesselEvidenceId("538006783"))).toEqual({ kind: "vessel", key: "538006783" });
    const url = vesselPageUrl("538006783");
    expect(url).toBe("https://www.vesselfinder.com/vessels/details/538006783");
    expect(publisherOf(url)).toBe("VesselFinder");
    expect(externalLinkProps(url)).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
  });
});

describe("vessels layer: drawing", () => {
  test("vessels layer: draws an arrow per ship with vessel:<mmsi>, trails, and moves the ships as the carp timeline moves", async () => {
    applyApp("carp");
    applyCarpView({ asOf: T });
    const requests: Record<string, unknown>[] = [];
    // The viewer's clock (client/globe/layers/clock.ts): in carp the layers' time is CARP.asOf.
    const ctx = {
      ...fakeContext({
        gql: async (query, variables) => {
          expect(query).toBe(VESSELS_QUERY);
          requests.push(variables ?? {});
          return { vessels: [TUG, TANKER] };
        },
      }),
      ...layerClock(),
    };
    const viewer = fakeViewer();
    const credits: unknown[] = [];
    (viewer as unknown as { creditDisplay: unknown }).creditDisplay = {
      addStaticCredit: (c: unknown) => credits.push(c),
      removeStaticCredit: (c: unknown) => credits.splice(credits.indexOf(c), 1),
    };
    const layer = createVesselsLayer(ctx);
    layer.init(viewer);
    layer.enable();
    expect(credits.length).toBe(1);
    expect((credits[0] as { html: string }).html).toBe(VESSEL_CREDIT);
    await flush(5);
    expect(requests.length).toBe(1);
    expect(requests[0]!.bbox).toEqual({ west: -94, south: 28.9, east: -88.8, north: 32.9 });
    const s1 = layer.stats();
    expect(s1.count).toBe(2);
    expect(s1.breakdown).toEqual({ tug: 1, tanker: 1 });
    expect(s1.vessels!.trails).toBe(1);
    expect(s1.vessels!.atMs).toBe(T);
    const ships = viewer.added.find((p) => (p as object).constructor.name === "BillboardCollection") as BillboardCollection;
    const trails = viewer.added.find((p) => (p as object).constructor.name === "PolylineCollection") as PolylineCollection;
    expect(ships.length).toBe(2);
    expect(ships.get(0).id).toBe("vessel:367123450");
    expect(ships.get(0).rotation).toBeCloseTo(-Math.PI / 2, 2);
    expect(ships.get(1).rotation).toBe(0);
    expect(trails.length).toBe(6);
    expect(trails.get(0).id).toBe("vessel:367123450");
    const lonAt = (s: typeof s1) => s.vessels!.positions["367123450"]![0];
    const before = lonAt(s1);
    // The "what we knew" time moves 20 minutes: the tug moves east, the anchored tanker stays.
    applyCarpView({ asOf: T + 20 * MIN });
    // The viewer refreshes the layers when CARP moves, as it does on TIME.
    layer.update(0, null);
    await flush(5);
    const s2 = layer.stats();
    expect(lonAt(s2)).toBeCloseTo(before + 0.06, 6);
    expect(s2.vessels!.positions["538006783"]).toEqual(s1.vessels!.positions["538006783"]!);
    expect(requests.length).toBe(1);
    layer.disable();
    expect(credits.length).toBe(0);
    expect(ships.show).toBe(false);
    layer.destroy();
    expect(viewer.added).toEqual([]);
    applyCarpView({ asOf: null });
    selectPython();
  });

  test("vessels layer: an app without the layer fetches nothing", async () => {
    selectPython();
    let calls = 0;
    const layer = createVesselsLayer(fakeContext({ gql: async () => (calls += 1, { vessels: [TUG] }) }));
    layer.init(fakeViewer());
    layer.enable();
    layer.update(0, null);
    await flush(5);
    expect(calls).toBe(0);
    expect(layer.stats().count).toBe(0);
    layer.destroy();
  });

  test("vessels layer: a species app follows TIME, and an API error is reported, not retried every frame", async () => {
    applyApp("lionfish");
    let calls = 0;
    const ctx = fakeContext({
      timeMs: T,
      gql: async () => {
        calls += 1;
        throw new Error("vessels: boom");
      },
    });
    const layer = createVesselsLayer(ctx);
    layer.init(fakeViewer());
    layer.enable();
    await flush(5);
    for (let i = 0; i < 5; i += 1) layer.update(i, null);
    await flush(5);
    expect(calls).toBe(1);
    expect(layer.stats().error).toBe("vessels: boom");
    layer.destroy();
    selectPython();
  });
});
