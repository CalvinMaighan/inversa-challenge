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
  /** When the newest stage observation was made (derived reviews), for "5m ago" in lists. */
  observedAtMs?: number | null;
};

/** The short phrase a list shows for a rule (the long text stays in the briefing). */
export const RULE_SHORT: Record<string, string> = {
  observed_category: "Over action stage",
  forecast_category: "Forecast over action stage",
  forecast_drift: "Forecast moved 1 ft+",
  stage_change: "Stage moved 1 ft+ in 24 h",
  nws_alerts: "Weather alert",
  stale_observation: "Gauge data old",
  missing_observation: "No gauge data",
  stale_forecast: "Forecast old",
  missing_forecast: "No forecast",
  no_thresholds: "No flood levels",
  stale_input: "Data old",
  missing_input: "Data missing",
  source_conflict: "Sources disagree",
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
  /** No thresholds were stored by asOf but some are now (fetched after it): said so, instead of "none known". */
  thresholdsLater?: boolean;
};

/** Why a status has no flood category, in words: thresholds stored only after this time, or none at all. */
export function noThresholdsText(later: boolean): string {
  return later
    ? "NWPS flood thresholds were first stored after this time, so no flood category is computed for it."
    : "No NWPS flood thresholds were known, so flood categories cannot be computed.";
}

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
    reasons.push(reason({ rule: "no_thresholds", kind: "gap", source: "nwps", link: links.nwps, value: input.thresholdsLater ? "stored_later" : "none", text: noThresholdsText(input.thresholdsLater === true) }));
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
  return { site: site.lid, asOfMs, status: review ? "review" : blind ? "cannot_assess" : "ok", reasons, freshness, origin: "derived", observedAtMs: Number.isFinite(newest) ? newest : null };
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const val = (v: unknown) => (typeof v === "number" || typeof v === "string" ? v : null);
const FRESHNESS = new Set<Freshness>(["FRESH", "AGING", "STALE", "MISSING"]);
/** C5's rules 5 and 6 (`stale_input`, `missing_input`) name an input that could not be used; the others put a site in review. */
const GAP_RULES = new Set(["stale_input", "missing_input"]);
/** C5's rule ids in this module's per-input vocabulary (the ids the board rows, the briefing and the e2e checks key on). */
const RULE_IDS: Record<string, string> = { stage_rise: "stage_change", active_alert: "nws_alerts", rapid_change_forecast: "forecast_drift" };
const INPUT_IDS: Record<string, Record<string, string>> = {
  stale_input: { observation: "stale_observation", forecast: "stale_forecast" },
  missing_input: { observation: "missing_observation", forecast: "missing_forecast", thresholds: "no_thresholds", baseline: "missing_baseline" },
};

/** A C5 rule id (with the input it names, `valueText`) as this module names it: rules 5 and 6 per input. */
export function clientRuleId(rule: string, input: string | null): string {
  return INPUT_IDS[rule]?.[input ?? ""] ?? RULE_IDS[rule] ?? rule;
}

/** C5's `ReviewReason` rows (fired reasons: `explanation` is the sentence) in this module's shape. */
function reasonsFromC5(list: unknown, status: string): ReviewReason[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .flatMap((x) => {
      const text = str(x.explanation) ?? str(x.text);
      if (!text) return [];
      const c5Rule = str(x.rule) ?? "rule";
      const rule = clientRuleId(c5Rule, str(x.valueText));
      const fired = typeof x.outcome !== "string" || x.outcome.toUpperCase() === "FIRED";
      return [
        {
          rule,
          value: val(x.value),
          threshold: val(x.threshold),
          source: str(x.source) ?? "",
          observedAt: str(x.observedAt),
          issuedAt: str(x.issuedAt),
          link: str(x.link),
          text,
          kind: GAP_RULES.has(c5Rule) ? ("gap" as const) : fired && status === "review" ? ("review" as const) : ("info" as const),
        },
      ];
    });
}

/** The freshness of a review's observation input from its reasons: rule 6 on the observation = missing, rule 5 = stale. */
function freshnessFromReasons(reasons: readonly ReviewReason[], fallback: Freshness): Freshness {
  for (const r of reasons) {
    if (r.rule === "missing_observation") return "MISSING";
    if (r.rule === "stale_observation") return "STALE";
  }
  return fallback;
}

/**
 * A past review whose thresholds were missing then but are held now: the row says they were stored after that
 * time (what C5's sentence cannot know; the board holds today's thresholds).
 */
export function withThresholdsLater(review: SiteReview, later: boolean): SiteReview {
  if (!later || !review.reasons.some((r) => r.rule === "no_thresholds")) return review;
  return { ...review, reasons: review.reasons.map((r) => (r.rule === "no_thresholds" ? { ...r, value: "stored_later", text: noThresholdsText(true) } : r)) };
}

/**
 * C5's review row (`siteReview`, a `reviewBoard.sites` entry, a `reviewHistory.initial`) in this module's shape;
 * null when it does not fit. The row's own `observationFreshness` wins over `freshness` (the caller's fallback).
 */
export function fromC5(row: unknown, asOfMs: number, freshness: Freshness): SiteReview | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status.toLowerCase() : "";
  if (typeof r.site !== "string" || !["review", "ok", "cannot_assess"].includes(status)) return null;
  const reasons = reasonsFromC5(r.reasons, status);
  const own = typeof r.observationFreshness === "string" ? (r.observationFreshness.toUpperCase() as Freshness) : null;
  return { site: r.site.toUpperCase(), asOfMs, status: status as ReviewStatus, reasons, freshness: own && FRESHNESS.has(own) ? own : freshnessFromReasons(reasons, freshness), origin: "c5" };
}

/** One site's `reviewHistory`: the review at `from`, then every change of status up to `to`. */
export type ReviewHistory = { site: string; fromMs: number; toMs: number; initial: SiteReview; transitions: { atMs: number; to: ReviewStatus; reasons: ReviewReason[] }[] };

/** C5's `reviewHistory` row in this module's shape; null when it does not fit. */
export function historyFromC5(row: unknown): ReviewHistory | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const fromMs = Date.parse(str(r.from) ?? "");
  const toMs = Date.parse(str(r.to) ?? "");
  const initial = fromC5(r.initial, fromMs, "MISSING");
  if (!initial || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const transitions = (Array.isArray(r.transitions) ? r.transitions : [])
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .flatMap((t) => {
      const atMs = Date.parse(str(t.at) ?? "");
      const to = typeof t.to === "string" ? t.to.toLowerCase() : "";
      if (!Number.isFinite(atMs) || !["review", "ok", "cannot_assess"].includes(to)) return [];
      return [{ atMs, to: to as ReviewStatus, reasons: reasonsFromC5(t.reasons, to) }];
    })
    .sort((a, b) => a.atMs - b.atMs);
  const site = str(r.site)?.toUpperCase() ?? initial.site;
  return { site, fromMs, toMs, initial: { ...initial, site }, transitions };
}

/**
 * The review at `asOfMs` from a site's history, without a request: the initial review, then the last transition
 * at or before that time (its status and the reasons that fired then). Null outside the history's window.
 */
export function reviewAt(h: ReviewHistory, asOfMs: number): SiteReview | null {
  if (asOfMs < h.fromMs || asOfMs > h.toMs) return null;
  let out: SiteReview = { ...h.initial, asOfMs };
  for (const t of h.transitions) {
    if (t.atMs > asOfMs) break;
    out = { site: h.site, asOfMs, status: t.to, reasons: t.reasons, freshness: freshnessFromReasons(t.reasons, "FRESH"), origin: "c5" };
  }
  return out;
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
