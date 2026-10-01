import { describe, expect, test } from "bun:test";

import { formatLatLon, unproject } from "client/hud/topbar/coords";
import { cellCenter, evidenceBadges, evidenceLocation, groupLinks, linkGroup, normalizeEvidence, parseBacktestId, parseHotspotId, recordRevisions } from "client/hud/drawer/evidence";
import { recentCitations, targetLabel } from "client/hud/overlay/targets";
import { isDrawerOpen } from "client/hud/selection";
import { parseEvidenceId } from "client/state/selection";
import { decodeShareLink, encodeShareLink } from "client/hud/share-link";
import type { AgentChatState } from "client/state/agent";

describe("evidence ids and links", () => {
  test("hotspot ids parse into species, 0.01° cell and frame time", () => {
    const h = parseHotspotId("hotspot:python:230:125:1727700000000")!;
    expect(h).toEqual({ species: "python", cell: "230:125", col: 230, row: 125, at: "2024-09-30T12:40:00.000Z" });
    const c = cellCenter(h.col, h.row);
    expect(c.lon).toBeCloseTo(-80.895, 9);
    expect(c.lat).toBeCloseTo(25.555, 9);
    expect(parseHotspotId("hotspot:python:230:125")).toBeNull();
    expect(parseHotspotId("sighting:230:125:1")).toBeNull();
  });

  test("link relations group into duplicate-of, duplicates, revisions and conflicts", () => {
    expect(linkGroup("duplicate_of")).toBe("duplicate_of");
    expect(linkGroup("duplicateOf")).toBe("duplicate_of");
    expect(linkGroup("canonical")).toBe("duplicate_of");
    expect(linkGroup("duplicate")).toBe("duplicates");
    expect(linkGroup("duplicates")).toBe("duplicates");
    expect(linkGroup("revision")).toBe("revisions");
    expect(linkGroup("conflicts_with")).toBe("conflicts");
    expect(linkGroup("supporting_sighting")).toBe("related");
    const g = groupLinks([
      { id: "sighting:2", relation: "duplicate", source: "gbif" },
      { id: "sighting:3", relation: "duplicate", source: "nas" },
      { id: "reading:x", relation: "conflict", source: "ndbc" },
    ]);
    expect(g.duplicates.length).toBe(2);
    expect(g.conflicts.map((l) => l.id)).toEqual(["reading:x"]);
    expect(g.revisions).toEqual([]);
  });

  test("badges count links, record revisions and the record's own conflict flag", () => {
    const record = {
      conflict: true,
      revisions: [
        { changedAt: "2026-09-30T10:00:00Z", field: "taxon", old: "Python molurus", new: "Python bivittatus" },
        { changedAt: null, field: "quality", old: null, new: "research" },
        "junk",
      ],
    };
    expect(recordRevisions(record)).toEqual([
      { changedAt: "2026-09-30T10:00:00Z", field: "taxon", old: "Python molurus", new: "Python bivittatus" },
      { changedAt: null, field: "quality", old: null, new: "research" },
    ]);
    // A duplicate naming another taxon is linked twice (duplicates + conflict): one conflict, not two.
    const links = [
      { id: "sighting:9", relation: "duplicate_of", source: "inat" },
      { id: "sighting:7", relation: "duplicates", source: "gbif" },
      { id: "sighting:7", relation: "conflict", source: "gbif" },
      { id: "fetch:3", relation: "fetch", source: "inat" },
    ];
    expect(evidenceBadges({ links, record })).toEqual([
      { group: "duplicate_of", count: 1 },
      { group: "duplicates", count: 1 },
      { group: "revisions", count: 2 },
      { group: "conflicts", count: 1 },
    ]);
    expect(evidenceBadges({ links: [], record: { conflict: true } })).toEqual([{ group: "conflicts", count: 1 }]);
    expect(evidenceBadges({ links: [], record: {} })).toEqual([]);
  });

  test("bracket locations come from lat/lon, then station, then the alert area", () => {
    expect(evidenceLocation({ lat: 25.1, lon: -80.4 })).toEqual({ lat: 25.1, lon: -80.4 });
    expect(evidenceLocation({ lat: "25.1", lon: "-80.4" })).toEqual({ lat: 25.1, lon: -80.4 });
    expect(evidenceLocation({ station: { lat: 24.7, lon: -81.1 } })).toEqual({ lat: 24.7, lon: -81.1 });
    expect(
      evidenceLocation({
        areaGeojson: {
          type: "Polygon",
          coordinates: [
            [
              [-81, 25],
              [-80, 25],
              [-80, 26],
              [-81, 26],
            ],
          ],
        },
      }),
    ).toEqual({ lon: -80.5, lat: 25.5 });
    expect(evidenceLocation({ areaGeojson: { type: "Feature", geometry: { type: "Point", coordinates: [-80.2, 25.8] } } })).toEqual({ lon: -80.2, lat: 25.8 });
    expect(evidenceLocation({ note: "no place" })).toBeNull();
  });

  test("evidence normalization lower-cases the feed envelope and fills gaps", () => {
    const e = normalizeEvidence({
      id: "sighting:1",
      kind: "sighting",
      record: { lat: 1 },
      raw: undefined,
      rawKey: null,
      sourceUrl: null,
      sourcePageUrl: null,
      fetchedAt: null,
      ingestLagSeconds: null,
      feed: { source: "inat", mode: "POLL", state: "LAGGING", lagSeconds: 300 },
      links: null,
    });
    expect(e.feed?.state).toBe("lagging");
    expect(e.links).toEqual([]);
    expect(e.raw).toBeNull();
    expect(normalizeEvidence({ ...e, feed: null, record: 42, links: [] }).record).toEqual({ value: 42 });
  });
});

describe("targets and selection", () => {
  test("recent citations: newest first, unique, valid ids only, capped", () => {
    const msg = (id: string, cites: string[]) => ({
      id,
      role: "assistant" as const,
      text: "",
      status: "done" as const,
      at: "2026-09-30T00:00:00Z",
      citations: cites.map((c) => ({ id: c, kind: "sighting" as const, label: c.slice(9) })),
    });
    const chat: AgentChatState = { sessionId: "s", messages: [msg("1", ["sighting:1", "sighting:2"]), msg("2", ["sighting:2", "bogus", "sighting:3"])] };
    expect(recentCitations(chat).map((c) => c.id)).toEqual(["sighting:3", "sighting:2", "sighting:1"]);
    expect(recentCitations(chat, 2).map((c) => c.id)).toEqual(["sighting:3", "sighting:2"]);
    expect(recentCitations(undefined)).toEqual([]);
  });

  test("bracket labels", () => {
    expect(targetLabel("hotspot:python:230:125:1727700000000")).toBe("HOTSPOT PYTHON 230:125");
    expect(targetLabel("sighting:48213")).toBe("SIGHTING 48213");
    expect(targetLabel("reading:ndbc_vakf1:water_c:1727700000000:measured")).toBe("READING …0000:measured");
    expect(targetLabel("sighting:48213", "python 48213")).toBe("SIGHTING python 48213");
  });

  test("backtest ids (C14) parse and count as evidence ids; share links keep them", () => {
    expect(parseBacktestId("backtest:python:14")).toEqual({ species: "python", days: 14 });
    expect(parseBacktestId("backtest:python:0")).toBeNull();
    expect(parseBacktestId("backtest:python")).toBeNull();
    expect(parseEvidenceId("backtest:iguana:30")?.kind).toBe("backtest");
    expect(parseBacktestId("sighting:1")).toBeNull();
    expect(parseBacktestId("backtest:python:x")).toBeNull();
    expect(decodeShareLink(encodeShareLink({ evidenceId: "backtest:iguana:30" })).evidenceId).toBe("backtest:iguana:30");
  });

  test("drawer opens on a selection unless drawerOpen is explicitly false", () => {
    expect(isDrawerOpen({ evidenceId: null })).toBe(false);
    expect(isDrawerOpen({ evidenceId: "sighting:1" })).toBe(true);
    expect(isDrawerOpen({ evidenceId: "sighting:1", drawerOpen: false })).toBe(false);
    expect(isDrawerOpen(undefined)).toBe(false);
  });
});

describe("cursor coordinates", () => {
  test("unproject inverts an affine projection and a curved one", () => {
    const affine = (lon: number, lat: number) => ({ x: 500 + (lon + 80.9) * 400, y: 400 - (lat - 25.9) * 450 });
    const hit = unproject(affine, 812, 133, { lon: -80.9, lat: 25.9 })!;
    const back = affine(hit.lon, hit.lat);
    expect(Math.hypot(back.x - 812, back.y - 133)).toBeLessThan(0.25);

    // Orthographic globe centred on the camera: strongly non-linear toward the limb.
    const R = 3000;
    const lon0 = -81;
    const lat0 = 26;
    const rad = Math.PI / 180;
    const ortho = (lon: number, lat: number) => {
      const cosc = Math.sin(lat0 * rad) * Math.sin(lat * rad) + Math.cos(lat0 * rad) * Math.cos(lat * rad) * Math.cos((lon - lon0) * rad);
      if (cosc < 0) return null;
      return {
        x: 600 + R * Math.cos(lat * rad) * Math.sin((lon - lon0) * rad),
        y: 400 - R * (Math.cos(lat0 * rad) * Math.sin(lat * rad) - Math.sin(lat0 * rad) * Math.cos(lat * rad) * Math.cos((lon - lon0) * rad)),
      };
    };
    const target = { lon: -60, lat: 40 };
    const p = ortho(target.lon, target.lat)!;
    const solved = unproject(ortho, p.x, p.y, { lon: lon0, lat: lat0 })!;
    expect(solved.lon).toBeCloseTo(target.lon, 3);
    expect(solved.lat).toBeCloseTo(target.lat, 3);
    // Off the globe (the sky): no answer.
    expect(unproject(ortho, 600 + R * 2, 400, { lon: lon0, lat: lat0 })).toBeNull();
  });

  test("lat/lon formatting", () => {
    expect(formatLatLon({ lat: 25.7617, lon: -80.1918 })).toBe("25.7617°N 80.1918°W");
    expect(formatLatLon({ lat: -1.5, lon: 2.25 }, 2)).toBe("1.50°S 2.25°E");
  });
});
