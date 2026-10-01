import { describe, expect, test } from "bun:test";

import { anchorOf } from "client/globe/hover";
import { ago, formatReading, placeTooltip, speciesName, tooltipLine, tooltipText } from "client/hud/tooltip/model";

const NOW = Date.parse("2026-09-30T20:40:00Z");
const MIN = 60_000;
const H = 60 * MIN;

describe("tooltip text", () => {
  test("relative ages read against the time cursor", () => {
    expect(ago(NOW - 30_000, NOW)).toBe("just now");
    expect(ago(NOW - 12 * MIN, NOW)).toBe("12 min ago");
    expect(ago(NOW - 2 * H, NOW)).toBe("2 h ago");
    expect(ago(NOW - 72 * H, NOW)).toBe("3 d ago");
    expect(ago(NOW + 5 * MIN, NOW)).toBe("in 5 min");
    expect(ago(Number.NaN, NOW)).toBe("time unknown");
  });

  test("station: network, name, latest value with unit, age", () => {
    const text = tooltipText(
      { kind: "station", source: "usgs", name: "Shark River", param: "STAGE_M", value: 1.2149, observedAtMs: NOW - 12 * MIN, lon: -80.9, lat: 25.3 },
      NOW,
    );
    expect(tooltipLine(text)).toBe("USGS gauge · Shark River · stage 1.21 m · 12 min ago");
    expect(tooltipLine(tooltipText({ kind: "station", source: "ndbc", name: "Fowey Rocks", param: "WATER_C", value: 29.04, observedAtMs: NOW - 2 * H, lon: 0, lat: 0 }, NOW))).toBe(
      "NDBC buoy · Fowey Rocks · water 29.0 °C · 2 h ago",
    );
    expect(tooltipLine(tooltipText({ kind: "station", source: "coops", name: "Virginia Key", param: "AIR_C", value: null, observedAtMs: NOW, lon: 0, lat: 0 }, NOW))).toBe(
      "NOAA tide gauge · Virginia Key · air — · just now",
    );
  });

  test("sighting: species, grade, then source and exact time once the evidence cache has the record", () => {
    const facts = { kind: "sighting" as const, id: 7, taxon: 3, quality: 0, ageMs: 2 * H, conflict: false, lon: -80.4, lat: 25.47 };
    expect(tooltipLine(tooltipText(facts, NOW))).toBe("Green iguana · research · 2 h ago");
    expect(tooltipLine(tooltipText(facts, NOW, { source: "inat", observedAt: new Date(NOW - 2 * H).toISOString() }))).toBe("Green iguana · research · iNat · 2 h ago");
    expect(tooltipLine(tooltipText({ ...facts, quality: 1, ageMs: 0, conflict: true }, NOW))).toBe("Green iguana · needs ID · this hour · IDs conflict");
    // A taxon outside the focus four takes its common name from the record.
    expect(tooltipLine(tooltipText({ ...facts, taxon: 99 }, NOW, { taxon: { commonName: "Cuban treefrog" } }))).toBe("Cuban treefrog · research · 2 h ago");
    // No record and nothing in the TAXA store yet: a plain placeholder, never "Other introduced species".
    expect(speciesName(99)).toBe("Introduced species");
    expect(speciesName(1)).toBe("Burmese python");
    // Once the TAXA store knows the taxon, the dot is named before its evidence loads; iNat's Title Case reads in sentence case.
    const anole = { id: 99, scientificName: "Anolis sagrei", commonName: "Brown Anole", focus: false, iconicGroup: "Reptilia", summary: null, photoUrl: null, pageUrl: null };
    expect(speciesName(99, null, { "99": anole })).toBe("Brown anole");
    expect(speciesName(99, null, { "99": { ...anole, commonName: "" } })).toBe("Anolis sagrei");
    expect(tooltipLine(tooltipText({ ...facts, taxon: 99 }, NOW, { taxon: { commonName: "Cuban Tree Frog" } }))).toBe("Cuban tree frog · research · 2 h ago");
  });

  test("alert: event until its expiry in Miami time, then severity", () => {
    const text = tooltipText({ kind: "alert", event: "Freeze Warning", severity: "Moderate", headline: null, expiresMs: Date.parse("2026-02-01T14:00:00Z") }, NOW);
    expect(text.title).toBe("Freeze Warning until 09:00");
    expect(tooltipLine(text)).toBe("Freeze Warning until 09:00 · moderate");
    expect(tooltipLine(tooltipText({ kind: "alert", event: "Flood Watch", severity: "Unknown", headline: null, expiresMs: null }, NOW))).toBe("Flood Watch");
  });

  test("hotspot: species, score to 2 decimals, labelled heuristic", () => {
    expect(tooltipLine(tooltipText({ kind: "hotspot", species: 0, score: 0.6234 }, NOW))).toBe("Burmese python hotspot · score 0.62 · heuristic");
  });

  test("readings without a known param still show", () => {
    expect(formatReading("SALINITY", 35)).toBe("salinity 35");
    expect(formatReading("SALINITY", null)).toBeNull();
  });

  test("points anchor to the marker; areas follow the pointer", () => {
    expect(anchorOf({ kind: "station", source: "usgs", name: "x", param: "STAGE_M", value: 1, observedAtMs: 0, lon: -80, lat: 25 })).toEqual({ lon: -80, lat: 25 });
    expect(anchorOf({ kind: "hotspot", species: 0, score: 0.5 })).toBeNull();
    expect(anchorOf({ kind: "alert", event: "x", severity: "minor", headline: null, expiresMs: null })).toBeNull();
  });

  test("placement: below-right of the anchor, flipped at the pane edges, never off the pane", () => {
    const pane = { width: 1000, height: 800 };
    expect(placeTooltip({ x: 100, y: 100 }, { width: 200, height: 30 }, pane)).toEqual({ x: 114, y: 114 });
    expect(placeTooltip({ x: 900, y: 100 }, { width: 200, height: 30 }, pane)).toEqual({ x: 686, y: 114 });
    expect(placeTooltip({ x: 100, y: 790 }, { width: 200, height: 30 }, pane)).toEqual({ x: 114, y: 746 });
    expect(placeTooltip({ x: 5, y: 5 }, { width: 1200, height: 30 }, pane)).toEqual({ x: 4, y: 19 });
  });
});
