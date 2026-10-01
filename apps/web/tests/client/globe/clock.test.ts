import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import { set } from "@calvinjs/active-state";

import { createAlertsLayer } from "client/globe/layers/alerts";
import { layerClock, layerPlaying, layerTimeMs } from "client/globe/layers/clock";
import { createStationsLayer } from "client/globe/layers/stations";
import { createVesselsLayer } from "client/globe/layers/vessels";
import { applyApp } from "client/state/app-switch";
import { applyCarpView, CARP } from "client/state/carp";
import { TIME } from "client/state/time";

import { fakeContext, fakeViewer, flush, installDom } from "./fakes";

const HOUR = 3_600_000;
const NOW = Date.now();
/** A past time on the hour, inside carp's 30-day "what we knew" range. */
const ASOF = Math.floor((NOW - 30 * HOUR) / HOUR) * HOUR;
const TIME_AT = "2026-09-09T20:00:00.000Z";

let restore: () => void;
beforeAll(() => {
  restore = installDom();
});
afterAll(() => {
  set(CARP, {});
  restore();
  selectPython();
});

describe("carp cursor", () => {
  test("carp cursor: a conditions app's layers draw at CARP.asOf, now when live; a species app's at TIME", () => {
    expect(layerTimeMs("conditions", { asOf: ASOF }, TIME_AT, NOW)).toBe(ASOF);
    expect(layerTimeMs("conditions", {}, TIME_AT, NOW)).toBe(NOW);
    expect(layerTimeMs("conditions", undefined, TIME_AT, NOW)).toBe(NOW);
    // TIME never leaks into carp, CARP never into a species app.
    expect(layerTimeMs("species", { asOf: ASOF }, TIME_AT, NOW)).toBe(Date.parse(TIME_AT));
  });

  test("carp cursor: playing is carp's replay (with an as-of time) in carp, TIME.playing elsewhere", () => {
    expect(layerPlaying("conditions", { asOf: ASOF, replay: true }, false)).toBe(true);
    expect(layerPlaying("conditions", { replay: true }, true)).toBe(false);
    expect(layerPlaying("conditions", {}, true)).toBe(false);
    expect(layerPlaying("species", { asOf: ASOF, replay: true }, false)).toBe(false);
    expect(layerPlaying("species", {}, true)).toBe(true);
  });

  test("carp cursor: layerClock reads the active app, CARP and TIME live", () => {
    const clock = layerClock(() => NOW);
    set(TIME, { ...TIME.defaults, at: TIME_AT, playing: true });
    applyApp("carp");
    applyCarpView({ asOf: ASOF, replay: true }, NOW);
    expect(clock.timeMs()).toBe(ASOF);
    expect(clock.playing()).toBe(true);
    applyCarpView({ asOf: null, replay: false }, NOW);
    expect(clock.timeMs()).toBe(NOW);
    expect(clock.playing()).toBe(false);
    selectPython();
    expect(clock.timeMs()).toBe(Date.parse(TIME_AT));
    expect(clock.playing()).toBe(true);
    set(TIME, TIME.defaults);
  });

  test("carp cursor: ships, alerts and stations ask for the as-of time once the viewer refreshes them, with no CARP subscription of their own", async () => {
    applyApp("carp");
    applyCarpView({ asOf: ASOF }, NOW);
    const asked: { layer: string; vars: Record<string, unknown> }[] = [];
    const ctx = {
      ...fakeContext({
        gql: async (query, vars) => {
          const layer = /GlobeVessels/.test(query) ? "vessels" : /GlobeAlerts/.test(query) ? "alerts" : "stations";
          asked.push({ layer, vars: vars ?? {} });
          return { vessels: [], alerts: [], readings: [] };
        },
      }),
      ...layerClock(() => NOW),
    };
    const layers = [createVesselsLayer(ctx), createAlertsLayer(ctx), createStationsLayer(ctx)];
    for (const l of layers) {
      l.init(fakeViewer());
      l.enable();
      l.update(0, null);
    }
    await flush(5);
    const at = (layer: string) => asked.filter((a) => a.layer === layer).map((a) => a.vars);
    // Vessels: the bucket holding the as-of time ends at or after it and starts before it.
    const v1 = at("vessels").at(-1)!;
    expect(Date.parse(v1.from as string)).toBeLessThan(ASOF);
    expect(Date.parse(v1.to as string)).toBeGreaterThanOrEqual(ASOF);
    // Alerts: in effect at the as-of hour; stations: readings up to it.
    expect(at("alerts").at(-1)!.at).toBe(new Date(ASOF).toISOString());
    expect(Date.parse(at("stations").at(-1)!.to as string)).toBeLessThanOrEqual(ASOF + HOUR);
    expect(Date.parse(at("stations").at(-1)!.to as string)).toBeGreaterThanOrEqual(ASOF);

    // The cursor moves a day on. Nothing is asked until the viewer refreshes (no layer listens to CARP itself) ...
    const before = asked.length;
    const later = ASOF + 24 * HOUR;
    applyCarpView({ asOf: later }, NOW);
    await flush(5);
    expect(asked.length).toBe(before);
    // ... then every layer follows the same cursor.
    for (const l of layers) l.update(0, null);
    await flush(5);
    expect(Date.parse(at("vessels").at(-1)!.to as string)).toBeGreaterThanOrEqual(later);
    expect(Date.parse(at("vessels").at(-1)!.from as string)).toBeLessThan(later);
    expect(at("alerts").at(-1)!.at).toBe(new Date(later).toISOString());
    expect(Date.parse(at("stations").at(-1)!.to as string)).toBeGreaterThanOrEqual(later);
    for (const l of layers) l.destroy();
    applyCarpView({ asOf: null }, NOW);
    selectPython();
  });
});
