/** Helpers every capability module shares: input schemas, the feed envelope, and the output builder. */

import { z } from "zod";

import type { CapabilityContext, CapabilityOutput, Evidence } from "@/server/agent/runtime/registry";
import { evidence } from "@/server/agent/tools/evidence";
import { toFeedState, type GqlFeedState } from "@/server/agent/tools/gql";
import type { BBox } from "@/shared/agent/events";
import { appBBox, clampToApp, type AppConfig } from "@/shared/apps";
import { worstHealth, type FeedState } from "@/shared/feed-state";

export const HOUR_MS = 3_600_000;

/**
 * An optional string argument the model meant to leave out. Models fill optional strings with placeholders
 * (" ", ".", ".*", ".invalid", "null", "none", "any"); those read as not given.
 */
export function given(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = value.trim().replace(/^[*\s]+|[*\s]+$/g, "");
  if (!s || /^[.*_\-?\d]{0,3}$/.test(s) || /^\.?(invalid|null|none|n\/a|undefined|any|all|default|not set|unset|unknown|tbd|placeholder|omit|skip|x\??)$/i.test(s)) return undefined;
  return s;
}

/** A time argument the model gave, or undefined for a placeholder or an unparsable value. */
export function givenTime(value: string | undefined | null): string | undefined {
  const s = given(value);
  return s !== undefined && Number.isFinite(Date.parse(s)) ? s : undefined;
}

/** A list argument with the placeholders dropped; undefined when nothing is left. */
export function givenList(values: readonly string[] | undefined): string[] | undefined {
  const kept = (values ?? []).map(given).filter((v): v is string => v !== undefined);
  return kept.length ? kept : undefined;
}

export const bboxSchema = z
  .object({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  })
  .refine((b) => b.west < b.east && b.south < b.north, "bbox needs west < east and south < north")
  .describe("Area in degrees. Get one from geocode. Defaults to the user's current view.");

export const timeSchema = z
  .string()
  // Models often send "" or a placeholder for an optional time they mean to leave out; those read as not given.
  .refine((value) => given(value) === undefined || Number.isFinite(Date.parse(value)), "must be an ISO 8601 time")
  .describe("ISO 8601 time, e.g. 2026-01-15T03:00:00Z");

/** The asked-for (or viewed) area cut to the app's extent; outside it the tool refuses with the app's refusal text (P4). */
export function resolveBbox(input: BBox | undefined, ctx: Pick<CapabilityContext, "app" | "view">): BBox {
  const bbox = input ?? ctx.view?.bbox ?? appBBox(ctx.app);
  const clamped = clampToApp(ctx.app, bbox);
  if (!clamped) throw new Error(`bbox is outside this app's regions (${ctx.app.regions.map((r) => r.name).join(", ")}). ${ctx.app.agent.refusal}`);
  return clamped;
}

/** `bbox` grown by `deg` on every side, clamped to the app's extent. */
export function padBbox(app: AppConfig, bbox: BBox, deg: number): BBox {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  const region = appBBox(app);
  return {
    west: r(Math.max(region.west, bbox.west - deg)),
    south: r(Math.max(region.south, bbox.south - deg)),
    east: r(Math.min(region.east, bbox.east + deg)),
    north: r(Math.min(region.north, bbox.north + deg)),
  };
}

export function atTime(input: string | undefined, ctx: CapabilityContext): string {
  const at = givenTime(input);
  return (at ? new Date(at) : ctx.now).toISOString();
}

/**
 * A lookback window from `from`/`to`/`hours`: placeholders read as not given; a `from` equal to `to` (a model
 * sending the same instant twice) or at or after the reference time falls back to the lookback so the call
 * still answers; an explicit `from` after an explicit `to` is an error.
 */
export function lookbackWindow(input: { from?: string; to?: string; hours?: number }, now: Date, defaultHours: number, maxHours: number): { from: string; to: string; fromIgnored: boolean } {
  const toText = givenTime(input.to);
  const to = toText ? new Date(toText) : now;
  const hours = Math.min(input.hours ?? defaultHours, maxHours);
  const fromText = givenTime(input.from);
  let from = fromText ? new Date(fromText) : new Date(to.getTime() - hours * HOUR_MS);
  let fromIgnored = false;
  if (from.getTime() >= to.getTime()) {
    if (fromText && toText && from.getTime() > to.getTime()) throw new Error("time window is empty: from must be before to");
    from = new Date(to.getTime() - hours * HOUR_MS);
    fromIgnored = true;
  }
  return { from: from.toISOString(), to: to.toISOString(), fromIgnored };
}

/** Feeds this result depends on: the sources seen in rows, else the tool's defaults. */
export function feedsFor(all: GqlFeedState[], seen: Iterable<string>, fallback: readonly string[] | "all"): GqlFeedState[] {
  if (fallback === "all") return all;
  const wanted = new Set(seen);
  return all.filter(
    (feed) => wanted.has(feed.source) || (wanted.size === 0 && fallback.some((prefix) => feed.source.startsWith(prefix))),
  );
}

/** A feed's last fetch run, citable as `fetch:<id>` when the API reports it. */
export function fetchEvidence(feed: GqlFeedState): Evidence | null {
  if (!feed.lastFetchRunId) return null;
  const state = toFeedState(feed);
  return evidence("fetch", feed.lastFetchRunId, `${feed.source} ${state.state} · last fetch ${feed.lastFetchAt ?? "never"}`, feed.source);
}

/** Age in words for the model: "25 min", "8 h", "25 days". */
export function ageWords(seconds: number): string {
  if (seconds < 90 * 60) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

/**
 * The analyst reads this summary before any claim about freshness. `mention` lists every feed that is not
 * nominal, with the citation marker already written, so naming a degraded feed and citing it is one copy.
 */
/** A feed switched off by configuration (note "disabled: …") is told to the model as `disabled`, not `down`. */
export const isDisabled = (feed: Pick<FeedState, "state" | "note">) => feed.state === "down" && !!feed.note?.startsWith("disabled:");

export function modelState(feed: Pick<FeedState, "state" | "note">): string {
  return isDisabled(feed) ? "disabled" : feed.state;
}

export function feedSummary(feeds: FeedState[]) {
  const pick = (state: FeedState["state"]) => feeds.filter((feed) => feed.state === state && !isDisabled(feed)).map((feed) => feed.source);
  return {
    worst: feeds.length > 0 ? worstHealth(feeds.filter((feed) => !isDisabled(feed))) : "unknown",
    lagging: pick("lagging"),
    stale: pick("stale"),
    down: pick("down"),
    disabled: feeds.filter(isDisabled).map((feed) => feed.source),
    mention: feeds
      .filter((feed) => feed.state !== "nominal")
      .map((feed) => ({
        source: feed.source,
        state: modelState(feed),
        newestObservation: feed.lagSeconds === null ? "none stored" : `${ageWords(feed.lagSeconds)} old`,
        note: feed.note,
        cite: feed.lastFetchRunId ? `[e:fetch:${feed.lastFetchRunId}]` : null,
      })),
  };
}

export function output(
  data: Record<string, unknown>,
  evidenceRows: Evidence[],
  rawFeeds: GqlFeedState[],
  count: number,
): CapabilityOutput {
  const feeds = rawFeeds.map(toFeedState);
  const fetches = rawFeeds.map(fetchEvidence);
  const allEvidence = [...evidenceRows, ...fetches.filter((row): row is Evidence => row !== null)];
  const modelFeeds = feeds.map((feed, index) => ({ ...feed, state: modelState(feed), evidenceId: fetches[index]?.id ?? null }));
  return {
    // Data-quality first, bulky rows last: if a long result is ever pruned head/tail, the caveats survive.
    data: { feedSummary: feedSummary(feeds), feeds: modelFeeds, ...data, evidence: allEvidence },
    evidence: allEvidence,
    feeds,
    count,
  };
}

/** A time in the app's local zone for the model ("2026-09-30 10:32 CDT"). */
export function localTime(app: AppConfig, at: string | number | Date): string {
  const date = typeof at === "string" ? new Date(at) : at instanceof Date ? at : new Date(at);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: app.copy.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}
