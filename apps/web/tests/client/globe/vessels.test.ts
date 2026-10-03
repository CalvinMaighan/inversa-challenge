import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";

import { createVesselsLayer, trailThirds, vesselBucket, vesselWindow } from "client/globe/layers/vessels";
import { plainSummary } from "client/hud/drawer/summary";
import { legendRows } from "client/hud/legend/model";
import { applyApp } from "client/state/app-switch";
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
  test("vessels layer: no app lists it any more (ships were removed from the maps); the AIS feed is gone from every app", () => {
    expect(LAYER_IDS).toContain("vessels");
    for (const id of ["carp", "lionfish", "python"] as const) {
      const app = getApp(id);
      expect(app.layers.some((l) => l.id === "vessels")).toBe(false);
      expect(legendRows(layersFor(app), null, app).some((r) => r.layer === "vessels")).toBe(false);
      const toggle = uiToolsFor(app).find((t) => t.name === "toggle_layer")!;
      expect(JSON.stringify(toggle.parameters)).not.toContain("vessels");
    }
    for (const id of ["carp", "lionfish", "python"] as const) expect(getApp(id).feeds.some((f) => f.source === "aisstream")).toBe(false);
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
  test("vessels layer: an app without the layer (every app now) fetches nothing", async () => {
    applyApp("carp");
    let calls = 0;
    const layer = createVesselsLayer(fakeContext({ gql: async () => (calls += 1, { vessels: [TUG] }) }));
    layer.init(fakeViewer());
    layer.enable();
    layer.update(0, null);
    await flush(5);
    expect(calls).toBe(0);
    expect(layer.stats().count).toBe(0);
    layer.destroy();
    selectPython();
  });
});
