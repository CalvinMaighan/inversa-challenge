/**
 * The Live data button's numbers, pure: what each source reported last and whether something new has come in since the
 * viewer looked. The feeds are the realtime envelopes the server publishes every 15 seconds (client/state/feeds.ts).
 */
import type { FeedHealth, FeedState } from "shared/feed-state";

import { feedLabel, formatLag } from "../topbar/feed-chips";

/** What each source is, in plain words: a name and the one thing it tells us. */
const SOURCES: Record<string, { name: string; what: string }> = {
  usgs: { name: "River gauges", what: "USGS: water level and flow" },
  nwps: { name: "River forecasts", what: "NOAA: flood-stage forecasts per gauge" },
  iem: { name: "Forecast archive", what: "Iowa Mesonet: past river forecasts" },
  "nws-alerts": { name: "Weather alerts", what: "NWS: warnings and watches" },
  nws: { name: "Weather alerts", what: "NWS: warnings and watches" },
  "nws-forecast": { name: "Weather forecast", what: "NWS: next days at each site" },
  nwws: { name: "NWS bulletins", what: "NWS: live text products" },
  inat: { name: "iNaturalist", what: "photo sightings by the public" },
  nas: { name: "USGS NAS", what: "agency and survey sightings" },
  gbif: { name: "GBIF", what: "museum and survey records" },
  crw: { name: "Reef heat stress", what: "NOAA Coral Reef Watch, daily" },
  ndbc: { name: "Ocean buoys", what: "NOAA: sea temperature and waves" },
  "openmeteo-marine": { name: "Waves and currents", what: "Open-Meteo marine forecast" },
  openmeteo: { name: "Weather model", what: "Open-Meteo forecast" },
  coops: { name: "Tide gauges", what: "NOAA: water level at the coast" },
  goes19: { name: "Satellite", what: "GOES-19 land and sea temperature" },
  "goes19-sst": { name: "Sea temperature", what: "GOES-19 satellite" },
};

/** The row's name and what it checks; an unknown source shows its id. */
export const describeSource = (source: string): { name: string; what: string } => SOURCES[source] ?? { name: feedLabel(source), what: "" };

export type LiveRow = {
  source: string;
  label: string;
  /** What the source checks, short. */
  what: string;
  state: FeedHealth;
  mode: FeedState["mode"];
  /** The newest record the source has given us, ms. */
  newestMs: number;
  /** When we last asked it, ms (null when never). */
  fetchedMs: number | null;
  /** "4m ago" for the newest record. */
  age: string;
  /** "2m ago" for the last time we asked the source, or null when never. */
  checked: string | null;
};

const ms = (iso: string | null): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** One row per source that has reported something, the freshest data first. */
export function liveRows(feeds: readonly FeedState[], nowMs: number): LiveRow[] {
  const rows: LiveRow[] = [];
  for (const f of feeds) {
    const newestMs = ms(f.newestObservedAt);
    if (newestMs === null) continue;
    rows.push({ source: f.source, label: describeSource(f.source).name, what: describeSource(f.source).what, state: f.state, mode: f.mode, newestMs, fetchedMs: ms(f.lastFetchAt), age: `${formatLag(Math.max(0, (nowMs - newestMs) / 1000))} ago`, checked: ms(f.lastFetchAt) === null ? null : `${formatLag(Math.max(0, (nowMs - (ms(f.lastFetchAt) ?? nowMs)) / 1000))} ago` });
  }
  return rows.sort((a, b) => b.newestMs - a.newestMs || a.label.localeCompare(b.label));
}

/** The newest record time across every source, or 0 when none has reported. */
export function latestMs(feeds: readonly FeedState[]): number {
  return feeds.reduce((max, f) => Math.max(max, ms(f.newestObservedAt) ?? 0), 0);
}

/** New data since the viewer last looked: `seen` is 0 before the first look, which only sets the baseline. */
export const hasNewData = (feeds: readonly FeedState[], seen: number): boolean => seen > 0 && latestMs(feeds) > seen;
