/**
 * What the voice model knows of the data before anyone asks: the app's newest reports and the feeds' freshness, read from the
 * API for "now" (the last 30 days over the whole app), never from what the timeline has drawn. It is a briefing for quick,
 * spoken answers (how many this week, what is newest, is a feed late); analysis, comparisons and anything with a reason go to
 * the analyst, which reads the same data with all its tools.
 */
import { gqlWithFeeds, MAX_API_WINDOW_MS, toFeedState, type GqlFeedState } from "@/server/agent/tools/gql";
import { ageWords } from "@/server/agent/tools/shared";
import { appBBox, regionAt, type AppConfig } from "@/shared/apps";
import { isDisabledFeed } from "@/shared/feed-state";

const QUERY = `query VoiceSnapshot($bbox: BBox!, $from: Time!, $to: Time!) {
  sightings(bbox: $bbox, from: $from, to: $to) {
    id source taxon { id commonName } lat lon observedAt quality conflict ingestedAt
  }
  feeds { ...FeedFields }
}
`;

type Row = { id: string; source: string; taxon: { id: string; commonName: string }; lat: number; lon: number; observedAt: string; quality: string; conflict: boolean; ingestedAt?: string | null };

const DAY_MS = 86_400_000;
const NEWEST = 8;
/** Why the last briefing could not be read (for the screen report and the log). */
export let lastSnapshotError: string | null = null;

/** The briefing as text for the voice model, or null when the API cannot be read (the analyst still works). */
export async function buildDataSnapshot(app: AppConfig, now = Date.now(), signal?: AbortSignal): Promise<string | null> {
  try {
    const to = new Date(now).toISOString();
    const from = new Date(now - Math.min(30 * DAY_MS, MAX_API_WINDOW_MS)).toISOString();
    const data = await gqlWithFeeds<{ sightings: Row[]; feeds: GqlFeedState[] }>("VoiceSnapshot", QUERY, { bbox: appBBox(app), from, to }, { app, signal });
    return snapshotText(app, data.sightings, data.feeds.filter((f) => !isDisabledFeed(f)).map(toFeedState), now);
  } catch (error) {
    lastSnapshotError = error instanceof Error ? error.message : String(error);
    console.warn("[voice] data snapshot failed:", lastSnapshotError);
    return null;
  }
}

export function snapshotText(app: AppConfig, rows: readonly Row[], feeds: ReturnType<typeof toFeedState>[], now: number): string {
  const within = (days: number) => rows.filter((r) => now - Date.parse(r.observedAt) <= days * DAY_MS);
  const count = (list: readonly Row[]) => {
    const by = new Map<string, number>();
    for (const r of list) by.set(r.taxon.commonName, (by.get(r.taxon.commonName) ?? 0) + 1);
    return [...by].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(", ");
  };
  const lines = [`Data as of ${new Date(now).toISOString()} (real time, not the timeline position), ${app.name}.`];
  for (const [label, days] of [["last 24 hours", 1], ["last 7 days", 7], ["last 30 days", 30]] as const) {
    const list = within(days);
    lines.push(`Sightings, ${label}: ${list.length}${list.length ? ` (${count(list)})` : ""}.`);
  }
  if (app.regions.length > 1) {
    const perRegion = app.regions.map((region) => `${region.name} ${within(7).filter((r) => regionAt(app, r.lat, r.lon)?.id === region.id).length}`);
    lines.push(`Last 7 days by area: ${perRegion.join(", ")}.`);
  }
  const late = within(30).filter((r) => r.ingestedAt && Date.parse(r.ingestedAt) - Date.parse(r.observedAt) > DAY_MS).length;
  if (rows.length) lines.push(`Of the last 30 days, ${late} were reported more than a day after they were seen, and ${rows.filter((r) => r.quality !== "RESEARCH").length} are not research grade.`);
  const newest = [...rows].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, NEWEST);
  if (newest.length) {
    lines.push("Newest sightings:");
    for (const r of newest) {
      const where = regionAt(app, r.lat, r.lon)?.name ?? `${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`;
      lines.push(`- ${r.observedAt.slice(0, 10)} ${r.taxon.commonName}, ${where}, ${r.source}, id sighting:${r.id}`);
    }
  }
  const feedLine = feeds.map((f) => `${f.source} ${f.state}${f.newestObservedAt ? ` (newest ${ageWords(Math.max(0, (now - Date.parse(f.newestObservedAt)) / 1000))} old)` : ""}`).join("; ");
  if (feedLine) lines.push(`Feeds: ${feedLine}.`);
  return lines.join("\n");
}
