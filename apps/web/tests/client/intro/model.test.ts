import { describe, expect, test } from "bun:test";

import { entryView, ENTRY_ALTITUDE_M, OVERVIEW_ALTITUDE_M, overviewView, progressOf, speciesCards } from "client/intro/model";
import { viewFor } from "client/state/view";
import { APP_IDS, getApp } from "shared/apps";

const base = viewFor(getApp(APP_IDS[0]), 7);

describe("first-run gate model", () => {
  test("the overview parks the camera high over the Americas and bumps seq so the globe flies", () => {
    const v = overviewView(base);
    expect(v.altitudeM).toBe(OVERVIEW_ALTITUDE_M);
    expect(v.altitudeM).toBeGreaterThan(10_000_000);
    expect(v.seq).toBe(base.seq + 1);
    expect(v.pitch).toBe(-90);
    expect(v.place).toBeNull();
  });

  test("the entry view is the app's own area from 5,000 km, for every app", () => {
    expect(ENTRY_ALTITUDE_M).toBe(5_000_000);
    for (const id of APP_IDS) {
      const preset = viewFor(getApp(id));
      const v = entryView(id, base);
      expect(v.altitudeM).toBe(5_000_000);
      expect([v.lat, v.lon]).toEqual([preset.lat, preset.lon]);
      expect(v.seq).toBe(base.seq + 1);
      expect(v.bbox.west).toBeLessThan(v.lon);
      expect(v.bbox.east).toBeGreaterThan(v.lon);
    }
  });

  test("one card per species app, in selector order, each with copy", () => {
    const cards = speciesCards();
    expect(cards.map((c) => c.id)).toEqual([...APP_IDS]);
    for (const c of cards) {
      expect(c.title.length).toBeGreaterThan(2);
      expect(c.area.length).toBeGreaterThan(2);
      expect(c.blurb.length).toBeGreaterThan(20);
    }
  });

  test("progress is a share of the requests that settled, 1 when there is nothing to fetch", () => {
    expect(progressOf(0, 0)).toBe(1);
    expect(progressOf(5, 10)).toBe(0.5);
    expect(progressOf(12, 10)).toBe(1);
  });
});
