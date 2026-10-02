import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { applyCarpView, ASOF_MAX_AGE_MS, CARP, carpSiteIds, goLive, normalizeAsOf, normalizeSite, selectSite, setAsOf, type CarpState } from "client/state/carp";
import { applyCarpViewEvent } from "client/agent/chat/effects";

init(state);

const NOW = Date.parse("2026-10-01T09:00:00Z");
const carp = (): CarpState => get<CarpState>(CARP) ?? {};

describe("CARP view state", () => {
  beforeEach(() => {
    applyApp("carp");
    set(CARP, CARP.defaults);
  });
  afterAll(() => applyApp("python"));

  test("starts live with nothing selected", () => {
    expect(CARP.defaults).toEqual({});
    expect(carpSiteIds()).toEqual(["SMML1", "KRZL1", "BLRL1", "MCGL1", "BTRL1", "AEXL1", "MLUL1", "BXAL1"]);
  });

  test("normalizeSite takes an NWPS id in any case or a location id, nothing else", () => {
    expect(normalizeSite("krzl1")).toBe("KRZL1");
    expect(normalizeSite("atchafalaya-morgan-city")).toBe("MCGL1");
    expect(normalizeSite("VLSL1")).toBeUndefined();
    expect(normalizeSite(42)).toBeUndefined();
  });

  test("normalizeAsOf clamps into the last 30 days, floors to the minute and treats now as live", () => {
    expect(normalizeAsOf(NOW - 3_600_000 + 1234, NOW)).toBe(NOW - 3_600_000);
    expect(normalizeAsOf(NOW - 30_000, NOW)).toBeUndefined();
    expect(normalizeAsOf(NOW + 86_400_000, NOW)).toBeUndefined();
    expect(normalizeAsOf(NOW - 90 * 86_400_000, NOW)).toBe(NOW - ASOF_MAX_AGE_MS);
    expect(normalizeAsOf("2026-09-30T20:00:00Z", NOW)).toBe(Date.parse("2026-09-30T20:00:00Z"));
    expect(normalizeAsOf("yesterday", NOW)).toBeUndefined();
  });

  test("applyCarpView keeps fields left out, clears null ones, and needs a past asOf to replay", () => {
    applyCarpView({ site: "KRZL1", asOf: NOW - 7_200_000 }, NOW);
    expect(carp()).toEqual({ site: "KRZL1", asOf: NOW - 7_200_000 });
    applyCarpView({ replay: true }, NOW);
    expect(carp()).toEqual({ site: "KRZL1", asOf: NOW - 7_200_000, replay: true });
    applyCarpView({ site: "nowhere" }, NOW);
    expect(carp().site).toBe("KRZL1");
    applyCarpView({ asOf: null }, NOW);
    expect(carp()).toEqual({ site: "KRZL1" });
    applyCarpView({ replay: true }, NOW);
    expect(carp()).toEqual({ site: "KRZL1" });
    selectSite(null);
    expect(carp()).toEqual({});
  });

  test("setAsOf stops a replay; goLive drops the time", () => {
    applyCarpView({ asOf: NOW - 7_200_000, replay: true }, NOW);
    setAsOf(NOW - 3_600_000, NOW);
    expect(carp()).toEqual({ asOf: NOW - 3_600_000 });
    goLive();
    expect(carp()).toEqual({});
  });

  test("an app switch clears it", () => {
    applyCarpView({ site: "MCGL1", asOf: NOW - 7_200_000 }, NOW);
    applyApp("lionfish");
    expect(carp()).toEqual({});
  });

  test("the agent's view event (AG1 contract): site, asOf in unix ms (absent = live), replay", () => {
    expect(applyCarpViewEvent({ type: "view", bbox: { west: 0, south: 0, east: 1, north: 1 }, time: "2026-10-01T00:00:00Z" }, NOW)).toBe(false);
    expect(carp()).toEqual({});
    expect(applyCarpViewEvent({ type: "view", site: "BTRL1", asOf: NOW - 86_400_000, replay: true }, NOW)).toBe(true);
    expect(carp()).toEqual({ site: "BTRL1", asOf: NOW - 86_400_000, replay: true });
    applyCarpViewEvent({ type: "view", site: "BTRL1" }, NOW);
    expect(carp()).toEqual({ site: "BTRL1" });
    applyApp("python");
    expect(applyCarpViewEvent({ type: "view", site: "BTRL1" }, NOW)).toBe(false);
  });
});
