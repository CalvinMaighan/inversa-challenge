/**
 * Data freshness in plain words for the About popover (T41): "Sightings checked 6 min ago", not "iNat LAGGING".
 * Pure over the C3 feed envelopes and the wall clock; the technical list sits under "Data sources".
 */
import type { FeedState } from "shared/feed-state";

import { ago } from "../tooltip/model";

/** Sources that deliver sightings, with the names a newcomer would recognise. */
export const SIGHTING_SOURCES: Readonly<Record<string, string>> = { inat: "iNaturalist", gbif: "GBIF", nas: "USGS NAS" };

const AND = new Intl.ListFormat("en", { type: "conjunction" });
const latest = (values: (string | null)[]) => values.reduce<number>((max, v) => (v && Number.isFinite(Date.parse(v)) ? Math.max(max, Date.parse(v)) : max), -Infinity);

export function freshnessLines(feeds: readonly FeedState[], nowMs: number): string[] {
  if (feeds.length === 0) return ["Waiting for the first data status."];
  const sightings = feeds.filter((f) => f.source.toLowerCase() in SIGHTING_SOURCES);
  const others = feeds.filter((f) => !(f.source.toLowerCase() in SIGHTING_SOURCES));
  const lines: string[] = [];
  const checked = latest(sightings.map((f) => f.lastFetchAt));
  lines.push(Number.isFinite(checked) ? `Sightings checked ${ago(checked, nowMs)}.` : "Sightings have not been checked yet.");
  const newest = latest(sightings.map((f) => f.newestObservedAt));
  if (Number.isFinite(newest)) lines.push(`Newest sighting reported ${ago(newest, nowMs)}.`);
  const late = sightings.filter((f) => f.state !== "nominal").map((f) => SIGHTING_SOURCES[f.source.toLowerCase()]!);
  if (late.length > 0) lines.push(`${AND.format(late)} ${late.length === 1 ? "is" : "are"} running late, so recent sightings may be missing.`);
  if (others.length > 0) {
    const down = others.filter((f) => f.state !== "nominal").length;
    lines.push(down === 0 ? "Weather and water data are up to date." : `Weather and water data: ${down} of ${others.length} sources delayed or offline.`);
  }
  return lines;
}
