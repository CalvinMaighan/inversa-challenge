"use client";

import { useEffect, useMemo, useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { isLive } from "client/hud/topbar/clock";
import { TIME, type TimeState } from "client/state/time";
import type { AppConfig } from "shared/apps";

import { loadBuoys, loadExplain, loadFeeds, loadHeat, loadMarine, loadReports, loadSnapshot, loadSnapshots, loadSources, snapshotTimes, type CellExplain, type ReportsLoad } from "./data";
import { areasOf, DAY, fieldPoints, groupHeat, HOUR, type Area, type FeedRow, type GqlReading, type HeatPixel, type MarinePoint, type PrioritySnapshot } from "./model";

/** Reports are loaded this far back (the 90-day window option). */
const REPORT_BACK_MS = 90 * DAY;
/** CRW, buoys and priority snapshots cover the timeline's 30 days. */
const REPLAY_BACK_MS = 30 * DAY;
const FIELD_HOURS = 72;
/** Ranked places shown per area. */
export const TOP_CELLS = 5;
/** Cells asked for per area: enough that TOP_CELLS places 10 km apart survive the clustering. */
const FETCH_CELLS = 60;

export type LionfishData = {
  areas: Area[];
  /** Load time: the live edge every query is anchored to. */
  liveMs: number;
  reports: ReportsLoad | null;
  heat: HeatPixel[] | null;
  buoys: GqlReading[] | null;
  marine: MarinePoint[] | null;
  /** Priority snapshots, oldest first; the live one first to arrive. */
  snapshots: PrioritySnapshot[];
  /** Every snapshot of the window has answered (or failed): scrubbing needs nothing more. */
  replayReady: boolean;
  feeds: FeedRow[] | null;
  sources: Record<string, Record<string, unknown>> | null;
  errors: string[];
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Everything the lionfish HUD draws, loaded once per mount, anchored to the load time. */
export function useLionfishData(app: AppConfig): LionfishData {
  const areas = useMemo(() => areasOf(app), [app]);
  const species = app.taxa[0]?.id ?? "";
  // Ten-minute steps keep the db worker's cache keys stable across quick reloads.
  const [liveMs] = useState(() => Math.floor(Date.now() / (10 * 60_000)) * 10 * 60_000);
  const [reports, setReports] = useState<ReportsLoad | null>(null);
  const [heatRows, setHeatRows] = useState<GqlReading[] | null>(null);
  const [buoys, setBuoys] = useState<GqlReading[] | null>(null);
  const [marineRows, setMarineRows] = useState<GqlReading[] | null>(null);
  const [snapshots, setSnapshots] = useState<PrioritySnapshot[]>([]);
  const [replayReady, setReplayReady] = useState(false);
  const [feeds, setFeeds] = useState<FeedRow[] | null>(null);
  const [sources, setSources] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const ctl = new AbortController();
    const signal = ctl.signal;
    const fail = (what: string) => (err: unknown) => {
      if (!signal.aborted) setErrors((e) => [...e, `${what}: ${message(err)}`]);
    };
    const add = (s: PrioritySnapshot) => {
      if (!signal.aborted) setSnapshots((prev) => [...prev.filter((p) => p.atMs !== s.atMs), s].sort((a, b) => a.atMs - b.atMs));
    };
    // The live picture first, then the history the timeline replays.
    loadSnapshot(species, areas, liveMs, FETCH_CELLS, signal)
      .then(add)
      .catch(fail("survey priority"))
      .finally(() => {
        if (signal.aborted) return;
        const times = snapshotTimes(liveMs, liveMs - REPLAY_BACK_MS).slice(1);
        void loadSnapshots(species, areas, times, FETCH_CELLS, add, signal).then(() => !signal.aborted && setReplayReady(true));
      });
    loadReports(areas, liveMs - REPORT_BACK_MS, liveMs, signal).then((r) => !signal.aborted && setReports(r), fail("reports"));
    loadHeat(areas, liveMs - REPLAY_BACK_MS, liveMs, signal).then((r) => !signal.aborted && setHeatRows(r), fail("reef heat stress"));
    loadBuoys(areas.slice(0, 1), liveMs - REPLAY_BACK_MS, liveMs, signal).then((r) => !signal.aborted && setBuoys(r), fail("buoys"));
    loadMarine(areas, liveMs - HOUR, FIELD_HOURS + 1, signal).then((r) => !signal.aborted && setMarineRows(r), fail("waves and currents"));
    loadFeeds(signal).then((f) => !signal.aborted && setFeeds(f), fail("feeds"));
    loadSources(signal).then((s) => !signal.aborted && setSources(s), () => {});
    return () => ctl.abort();
  }, [species, areas, liveMs]);

  const heat = useMemo(() => (heatRows ? groupHeat(heatRows, areas) : null), [heatRows, areas]);
  const marine = useMemo(() => (marineRows ? fieldPoints(marineRows, areas, liveMs, FIELD_HOURS) : null), [marineRows, areas, liveMs]);
  return { areas, liveMs, reports, heat, buoys, marine, snapshots, replayReady, feeds, sources, errors };
}

/** The time cursor (TIME.at) in ms, and whether it sits on the live edge. */
export function useCursor(): { atMs: number; live: boolean } {
  const at = useActiveState<TimeState, string>(TIME, (t) => t.at ?? t.to)[0] ?? TIME.defaults.at;
  const live = useActiveState<TimeState, boolean>(TIME, (t) => isLive(t, Date.now()))[0] ?? true;
  return { atMs: Date.parse(at), live };
}

export type ExplainState = { data: CellExplain | null; loading: boolean; error: string | null };

/** `explainCell` for the selected cell at its time. */
export function useExplain(species: string, cell: string | null, atMs: number | null): ExplainState {
  const [state, setState] = useState<ExplainState & { key: string }>({ key: "", data: null, loading: false, error: null });
  const key = cell && atMs !== null ? `${cell}@${atMs}` : "";
  useEffect(() => {
    if (!cell || atMs === null) return;
    const ctl = new AbortController();
    loadExplain(species, cell, atMs, ctl.signal).then(
      (data) => !ctl.signal.aborted && setState({ key: `${cell}@${atMs}`, data, loading: false, error: null }),
      (err) => !ctl.signal.aborted && setState({ key: `${cell}@${atMs}`, data: null, loading: false, error: message(err) }),
    );
    return () => ctl.abort();
  }, [species, cell, atMs]);
  if (!key) return { data: null, loading: false, error: null };
  return state.key === key ? state : { data: null, loading: true, error: null };
}
