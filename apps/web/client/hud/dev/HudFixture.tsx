"use client";

import { useEffect, useState } from "react";
import { set } from "@calvinjs/active-state";
import { allocFrameGrid, writeFrameFromEvf, type FrameGrid } from "@calvinjs/active-state/threads";

import type { FeedState } from "shared/feed-state";
import { QUALITY_CODES } from "shared/frames";
import { SPECIES_IDS } from "shared/voice/ui-tools";

import AgentColumn from "client/agent";
import { AGENT_CHAT, type AgentChatState } from "client/state/agent";
import { FEEDS } from "client/state/feeds";
import { SELECTION } from "client/state/selection";
import { TIME, type TimeState } from "client/state/time";
import styled from "client/styled";
import { publishFrameGrid, publishFrameSightings } from "client/threads/api";
import AppShell from "client/ui/AppShell";

import { backtestKey, evidenceKey, explainKey, primeCache, type Backtest, type Evidence, type HotspotExplain } from "../drawer/evidence";
import Hud from "../index";
import type { HudSelection } from "../selection";
import { alertRows } from "../Sync";
import { buildFixtureEvf, evfFrames, evfFrameSightings, FIXTURE_FRAMES, FIXTURE_SCRIPT, FIXTURE_STEP_MINUTES } from "./fixture";
import FixtureGlobe from "./FixtureGlobe";

const STEP_MS = FIXTURE_STEP_MINUTES * 60_000;
const [PYTHON, , IGUANA] = SPECIES_IDS;

const Message = styled.p`
  position: absolute;
  inset: 0;
  margin: 0;
  display: grid;
  place-items: center;
  font: 14px var(--font-mono);
  color: var(--muted);
`;

const MissionList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
  li {
    padding: var(--gap-s) 0;
    border-bottom: 1px solid var(--border);
  }
  small {
    display: block;
    color: var(--muted);
    font-family: var(--font-mono);
  }
`;

function feeds(nowMs: number): FeedState[] {
  const iso = (agoS: number) => new Date(nowMs - agoS * 1000).toISOString();
  const feed = (source: string, mode: FeedState["mode"], state: FeedState["state"], lag: number | null, note: string | null): FeedState => ({
    source,
    mode,
    state,
    newestObservedAt: lag === null ? null : iso(lag),
    lastFetchAt: iso(Math.min(lag ?? 600, 120)),
    lastFetchRunId: String(9000 + source.length),
    lagSeconds: lag,
    note,
  });
  return [
    feed("coops", "poll", "nominal", 420, null),
    feed("gbif", "poll", "lagging", 3 * 86400, "GBIF republishes iNat research-grade records days later"),
    feed("goes19", "push", "down", 7200, "No SQS delivery for 2 h; LST/SST frames missing"),
    feed("inat", "poll", "stale", 12.5 * 3600, "No new observations since last night"),
    feed("ndbc", "poll", "nominal", 540, null),
    feed("nws", "poll", "nominal", 45, null),
    feed("usgs", "poll", "nominal", 900, null),
  ];
}

/** Evidence, explain and backtest results for the fixture's selection and citations, so the drawer works offline. */
function primeEvidence(frame0Ms: number, hotspotId: string, sightingId: string) {
  const at = new Date(frame0Ms + 40 * STEP_MS).toISOString();
  const inat = feeds(Date.now()).find((f) => f.source === "inat")!;
  const hotspot: Evidence = {
    id: hotspotId,
    kind: "hotspot",
    record: { species: PYTHON, cell: "230:125", at, score: 0.742, lat: 25.555, lon: -80.895 },
    raw: null,
    rawKey: null,
    sourceUrl: null,
    fetchedAt: at,
    ingestLagSeconds: 0,
    feed: null,
    links: [{ id: sightingId, relation: "supporting_sighting", source: "inat" }],
  };
  const sighting: Evidence = {
    id: sightingId,
    kind: "sighting",
    record: {
      id: 48213,
      source: "inat",
      taxon: "Python bivittatus",
      lat: 25.6012,
      lon: -80.8421,
      observedAt: at,
      quality: QUALITY_CODES[0],
      accuracyM: 12,
      canonicalId: null,
      conflict: false,
      // An iNat ID flip, as T10 lists it (revisions have no id of their own).
      revisions: [{ changedAt: new Date(Date.parse(at) + 3_600_000).toISOString(), field: "taxon", old: "Python molurus", new: "Python bivittatus" }],
    },
    raw: {
      id: 194820331,
      quality_grade: QUALITY_CODES[0],
      observed_on: at.slice(0, 10),
      location: "25.6012,-80.8421",
      taxon: { id: 238252, name: "Python bivittatus", rank: "species", preferred_common_name: "Burmese Python" },
      identifications: [
        { user: "fieldcrew_7", taxon_id: 238252, current: true },
        { user: "herp_id", taxon_id: 238252, current: true },
      ],
      photos: [{ id: 1, url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg" }],
    },
    rawKey: "raw/inat/2026/09/30/0412.json.gz",
    sourceUrl: "https://www.inaturalist.org/observations/194820331",
    fetchedAt: new Date(Date.parse(at) + 540_000).toISOString(),
    ingestLagSeconds: 540,
    feed: inat,
    links: [
      { id: "sighting:48990", relation: "duplicate", source: "gbif" },
      { id: "sighting:49102", relation: "duplicate", source: "nas" },
      { id: "fetch:9004", relation: "fetch", source: "inat" },
      { id: "reading:ndbc_vakf1:water_c:1727700000000:measured", relation: "conflict", source: "ndbc" },
    ],
  };
  const explain: HotspotExplain = {
    cell: "230:125",
    species: PYTHON,
    at,
    score: 0.742,
    terms: [
      { name: "density", value: 0.91, rationale: "6 sightings within 3 km in 21 d half-life window" },
      { name: "activity", value: 0.88, rationale: "Night LST 24.1 °C inside the 22–30 °C python window" },
      { name: "access", value: 0.93, rationale: "L-67 levee within 1.2 km; stage 1.9 m below the 2.4 m cutoff" },
    ],
  };
  const backtest = (species: string, days: number): Backtest => ({
    species,
    days,
    hitRate: 0.31,
    baseline: 0.1,
    perDay: Array.from({ length: days }, (_, i) => ({
      day: new Date(frame0Ms - (days - i) * 86_400_000).toISOString(),
      sightings: 4 + ((i * 7) % 9),
      hits: 1 + ((i * 5) % 4),
    })),
  });
  primeCache(evidenceKey(hotspotId), hotspot);
  primeCache(evidenceKey(sightingId), sighting);
  primeCache(explainKey(explain.cell, PYTHON, at), explain);
  for (const species of SPECIES_IDS) for (const days of [7, 14, 30]) primeCache(backtestKey(species, days), backtest(species, days));
}

type Ready = { grid: FrameGrid } | { error: string };

/**
 * Dev route body: builds 96 synthetic EVF2 frames, copies their fixed parts into a SAB frame grid, publishes
 * it (and the per-frame sighting counts) the way the db worker would, seeds feeds, alerts and a selection,
 * and mounts the real `Hud` over a flat stand-in globe.
 */
export default function HudFixture() {
  const [ready, setReady] = useState<Ready | null>(null);

  useEffect(() => {
    const to = Math.floor(Date.now() / STEP_MS) * STEP_MS;
    const from = to - (FIXTURE_FRAMES - 1) * STEP_MS;
    let result: Ready;
    try {
      const fixture = buildFixtureEvf(from);
      const { header, offsets } = evfFrames(fixture.bytes);
      const grid = allocFrameGrid({
        frameCount: header.frameCount,
        hsCols: header.hsCols,
        hsRows: header.hsRows,
        speciesCount: header.speciesCount,
        envCols: header.envCols,
        envRows: header.envRows,
        hotspotScale: header.hotspotScale,
      });
      for (let f = 0; f < header.frameCount; f++) writeFrameFromEvf(grid, f, fixture.bytes, offsets[f]!);
      grid.bump();

      const iso = (ms: number) => new Date(ms).toISOString();
      // Start on the cloud deck so the page opens on a hatched frame.
      set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, from: iso(from), to: iso(to), at: iso(from + (FIXTURE_SCRIPT.cloud[0] + 4) * STEP_MS), playing: false }));
      set<FeedState[]>(FEEDS, feeds(Date.now()));
      alertRows.set([
        { id: "nws-freeze-1", event: "Freeze Warning", severity: "Severe", headline: "Freeze Warning for inland Miami-Dade", onset: iso(from + 8 * STEP_MS), expires: iso(from + 36 * STEP_MS) },
        { id: "nws-sca-1", event: "Small Craft Advisory", severity: "Moderate", headline: "Small Craft Advisory, Florida Keys", onset: iso(from + 20 * STEP_MS), expires: iso(from + 70 * STEP_MS) },
        { id: "nws-flood-1", event: "Flood Advisory", severity: "Minor", headline: null, onset: iso(from + 82 * STEP_MS), expires: null },
      ]);
      const hotspotId = `hotspot:${PYTHON}:230:125:${from + 40 * STEP_MS}`;
      const sightingId = "sighting:48213";
      primeEvidence(from, hotspotId, sightingId);
      set<HudSelection>(SELECTION, { evidenceId: hotspotId, drawerOpen: true });
      set<AgentChatState>(AGENT_CHAT, {
        sessionId: "fixture",
        messages: [
          {
            id: "m1",
            role: "assistant",
            text: "Python activity peaks tonight near L-67.",
            citations: [
              { id: sightingId, kind: "sighting", label: "python 48213" },
              { id: `hotspot:${IGUANA}:295:150:${from}`, kind: "hotspot", label: "iguana Miami" },
            ],
            status: "done",
            at: iso(to),
          },
        ],
      });
      publishFrameGrid(grid, {
        frame0UnixMs: header.frame0UnixMs,
        stepMinutes: header.stepMinutes,
        frameCount: header.frameCount,
        geometry: { west: header.west, south: header.south, hsCellDeg: header.hsCellDeg, envCellDeg: header.envCellDeg },
      });
      publishFrameSightings(evfFrameSightings(fixture.bytes));
      result = { grid };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    queueMicrotask(() => setReady(result));
  }, []);

  if (!ready) return <Message>Building fixture frames…</Message>;
  if ("error" in ready) return <Message role="alert">Fixture failed: {ready.error}</Message>;
  return (
    <AppShell
      side={
        <AgentColumn
          missions={
            <MissionList>
              <li>
                Python sweep, L-67 levee
                <small>planned · python · 20:00–02:00 EDT</small>
              </li>
              <li>
                Iguana cold-stun collection, Coral Gables
                <small>in progress · iguana · 3 removals</small>
              </li>
            </MissionList>
          }
        />
      }
      globe={<FixtureGlobe grid={ready.grid} />}
      hud={<Hud sync={false} />}
    />
  );
}
