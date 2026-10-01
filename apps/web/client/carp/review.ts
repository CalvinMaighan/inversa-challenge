/**
 * "Needs review" per location: the one shape the board, the markers and the briefing read.
 *
 * Source of truth is C5's `siteReview(site, asOf)` / `reviewBoard(asOf)` (status `review | ok | cannot_assess`,
 * reasons `{rule, value, threshold, source, observedAt, issuedAt, link, text}`). Until the API serves those, the
 * same shape is derived here from `siteStatusAt`, the river forecast in force and USGS readings
 * (`deriveReview`). `fromC5` is the adapter: a change in C5's field shapes is a change in this file only.
 */
import { ago, ft, localDay, localTime, signedFt } from "./format";
import {
  CATEGORY_WORDS,
  categoryRank,
  change24h,
  forecastDrift,
  forecastPeak,
  freshnessOfForecast,
  freshnessOfObservation,
  latestAt,
  thresholdList,
  type Freshness,
  type Site,
  type SiteStatus,
  type Snapshot,
  type UsgsSeries,
} from "./model";

export type ReviewStatus = "review" | "ok" | "cannot_assess";

export type ReviewReason = {
  rule: string;
  value: number | string | null;
  threshold: number | string | null;
  source: string;
  observedAt: string | null;
  issuedAt: string | null;
  link: string | null;
  text: string;
  /** `review`: why the site needs review; `gap`: an input that could not be used; `info`: context. */
  kind: "review" | "gap" | "info";
};

export type SiteReview = {
  site: string;
  asOfMs: number;
  status: ReviewStatus;
  reasons: ReviewReason[];
  /** Freshness of the newest stage observation from either source, for the marker ring. */
  freshness: Freshness;
  /** Where the status came from: C5's review service or this file's derivation. */
  origin: "c5" | "derived";
};

/** Stage change over 24 h that asks for review, feet. */
export const STAGE_CHANGE_REVIEW_FT = 1;
/** The forecast for one valid time moved this much since the previous issuance: review. */
export const DRIFT_REVIEW_FT = 1;

/** "No rule fired", not "safe": the rules cover river and weather data only, never access or trip safety. */
export const STATUS_WORDS: Record<ReviewStatus, string> = { review: "Needs review", ok: "No rule fired", cannot_assess: "Cannot assess" };

/** Public pages for a site's sources, opened in a new tab. */
export function sourceLinks(site: Site): { nwps: string; usgs: string | null; nws: string; iem: string } {
  return {
    nwps: `https://water.noaa.gov/gauges/${site.lid.toLowerCase()}`,
    usgs: site.usgs ? `https://waterdata.usgs.gov/monitoring-location/${site.usgs}/` : null,
    nws: `https://forecast.weather.gov/MapClick.php?lat=${site.lat.toFixed(4)}&lon=${site.lon.toFixed(4)}`,
    iem: "https://mesonet.agron.iastate.edu/request/hml.php",
  };
}

export type ReviewInput = {
  site: Site;
  asOfMs: number;
  /** Live (asOf is now) or "what we knew" at a past time. */
  live: boolean;
  zone: string;
  status: SiteStatus | null;
  /** River forecast in force at asOf, and the issuance before it. */
  forecast: Snapshot | null;
  previous: Snapshot | null;
  usgs: UsgsSeries;
};

const reason = (r: Omit<ReviewReason, "value" | "threshold" | "observedAt" | "issuedAt" | "link"> & Partial<ReviewReason>): ReviewReason => ({
  value: null,
  threshold: null,
  observedAt: null,
  issuedAt: null,
  link: null,
  ...r,
});

const SOURCE_LABEL: Record<string, string> = { NWPS_LIVE: "NWPS, captured live", IEM_ARCHIVE: "IEM archive copy of the NWS forecast", NWS_GRIDPOINT: "NWS gridpoint" };
export const forecastSourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

/** The derivation used until C5 serves `siteReview`. Rules in the module comment of `model.ts`. */
export function deriveReview(input: ReviewInput): SiteReview {
  const { site, asOfMs, zone, status, forecast, previous, usgs } = input;
  const links = sourceLinks(site);
  const reasons: ReviewReason[] = [];
  const thresholds = thresholdList(status?.thresholds);
  const action = thresholds.find((t) => t.key === "actionFt")?.ft ?? null;

  // Observations: NWPS (the flood-category datum) from siteStatusAt, USGS gauge height for change.
  const obs = status?.observation ?? null;
  const obsMs = obs ? Date.parse(obs.observedAt) : null;
  const obsFresh = status ? status.observationFreshness : "MISSING";
  const usgsLast = latestAt(usgs.stageFt, asOfMs);
  // USGS readings carry no receipt time, so in the past they cannot show what was held: freshness is NWPS's then.
  const newest = Math.max(obsMs ?? -Infinity, input.live ? (usgsLast?.t ?? -Infinity) : -Infinity);
  const freshness = freshnessOfObservation(Number.isFinite(newest) ? newest : null, asOfMs);

  if (obsFresh === "STALE") {
    reasons.push(reason({ rule: "stale_observation", kind: "gap", source: "nwps", observedAt: obs?.observedAt ?? null, link: links.nwps, text: `Newest NWPS stage was observed ${ago(obsMs, asOfMs)} (stale after 6 h), so it is left out of the review.` }));
  } else if (obsFresh === "MISSING") {
    reasons.push(reason({ rule: "missing_observation", kind: "gap", source: "nwps", link: links.nwps, text: "No NWPS stage observation was held at this time, so observed conditions cannot be assessed." }));
  } else if (obs && categoryRank(status?.category) >= 1) {
    reasons.push(
      reason({
        rule: "observed_category",
        kind: "review",
        source: "nwps",
        value: obs.stageFt,
        threshold: action,
        observedAt: obs.observedAt,
        link: links.nwps,
        text: `Observed stage ${ft(obs.stageFt)} is at ${CATEGORY_WORDS[status!.category!]} (action ${ft(action, 1)}, NWPS).`,
      }),
    );
  }

  // Forecast in force: stale after 36 h, dropped from the review with the reason stated.
  const fFresh = freshnessOfForecast(forecast, asOfMs);
  const peak = forecastPeak(forecast);
  if (fFresh === "MISSING") {
    reasons.push(reason({ rule: "missing_forecast", kind: "gap", source: "nwps", link: links.nwps, text: "No river forecast was held at this time." }));
  } else if (fFresh === "STALE") {
    reasons.push(reason({ rule: "stale_forecast", kind: "gap", source: "nwps", issuedAt: forecast!.issuedAt, link: links.nwps, text: `River forecast was issued ${ago(Date.parse(forecast!.issuedAt), asOfMs)} (stale after 36 h), so it is left out of the review.` }));
  } else if (peak && action !== null && peak.ft >= action) {
    reasons.push(
      reason({
        rule: "forecast_category",
        kind: "review",
        source: forecast!.source === "IEM_ARCHIVE" ? "iem" : "nwps",
        value: peak.ft,
        threshold: action,
        issuedAt: forecast!.issuedAt,
        link: links.nwps,
        text: `Forecast peak ${ft(peak.ft, 1)} on ${localDay(peak.at, zone)} reaches action stage (${ft(action, 1)}).`,
      }),
    );
  }
  const drift = fFresh !== "MISSING" && fFresh !== "STALE" ? forecastDrift(forecast, previous) : null;
  if (drift && Math.abs(drift.ft) >= DRIFT_REVIEW_FT) {
    reasons.push(
      reason({
        rule: "forecast_drift",
        kind: "review",
        source: "nwps",
        value: drift.ft,
        threshold: DRIFT_REVIEW_FT,
        issuedAt: forecast!.issuedAt,
        link: links.nwps,
        text: `Forecast for ${localTime(drift.at, zone)} moved ${signedFt(drift.ft, 1)} since the issuance of ${localDay(Date.parse(previous!.issuedAt), zone)}.`,
      }),
    );
  }

  if (status && thresholds.length === 0) {
    reasons.push(reason({ rule: "no_thresholds", kind: "gap", source: "nwps", link: links.nwps, text: "No NWPS flood thresholds were known, so flood categories cannot be computed." }));
  }

  const change = change24h(usgs.stageFt, asOfMs, site.tidal);
  if (change && Math.abs(change.ft) >= STAGE_CHANGE_REVIEW_FT) {
    reasons.push(
      reason({
        rule: "stage_change",
        kind: "review",
        source: "usgs",
        value: change.ft,
        threshold: STAGE_CHANGE_REVIEW_FT,
        observedAt: usgsLast ? new Date(usgsLast.t).toISOString() : null,
        link: links.usgs,
        text: `Stage ${change.ft > 0 ? "rose" : "fell"} ${ft(Math.abs(change.ft))} in 24 h${change.method === "mean" ? " (24 h means, tidal site)" : ""} (USGS gauge height).`,
      }),
    );
  }

  if ((status?.activeAlerts ?? 0) > 0) {
    const n = status!.activeAlerts;
    reasons.push(reason({ rule: "nws_alerts", kind: "review", source: "nws", value: n, link: links.nws, text: `${n} NWS alert${n === 1 ? "" : "s"} in effect at the location.` }));
  }

  const review = reasons.some((r) => r.kind === "review");
  const blind = obsFresh === "STALE" || obsFresh === "MISSING" || fFresh === "STALE" || fFresh === "MISSING" || (status !== null && thresholds.length === 0) || status === null;
  return { site: site.lid, asOfMs, status: review ? "review" : blind ? "cannot_assess" : "ok", reasons, freshness, origin: "derived" };
}

/** C5's review row (`siteReview` / `reviewBoard` entry) in this module's shape; null when it does not fit. */
export function fromC5(row: unknown, asOfMs: number, freshness: Freshness): SiteReview | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status.toLowerCase() : "";
  if (typeof r.site !== "string" || !["review", "ok", "cannot_assess"].includes(status)) return null;
  const list = Array.isArray(r.reasons) ? r.reasons : [];
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const val = (v: unknown) => (typeof v === "number" || typeof v === "string" ? v : null);
  const reasons: ReviewReason[] = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string")
    .map((x) => ({
      rule: str(x.rule) ?? "rule",
      value: val(x.value),
      threshold: val(x.threshold),
      source: str(x.source) ?? "",
      observedAt: str(x.observedAt),
      issuedAt: str(x.issuedAt),
      link: str(x.link),
      text: x.text as string,
      kind: status === "review" ? "review" : status === "cannot_assess" ? "gap" : "info",
    }));
  return { site: r.site.toUpperCase(), asOfMs, status: status as ReviewStatus, reasons, freshness, origin: "c5" };
}

const STATUS_RANK: Record<ReviewStatus, number> = { review: 0, cannot_assess: 1, ok: 2 };

/** Board order: needs review (most reasons first), then cannot assess, then fine; by name within a group. */
export function sortBoard<T extends { review: SiteReview; site: Site }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const s = STATUS_RANK[a.review.status] - STATUS_RANK[b.review.status];
    if (s) return s;
    const n = b.review.reasons.filter((r) => r.kind === "review").length - a.review.reasons.filter((r) => r.kind === "review").length;
    return n || a.site.name.localeCompare(b.site.name);
  });
}
