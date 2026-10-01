/**
 * "Needs review" rules for the carp conditions app (docs/APPS.md; the C5 engine's contract, mirrored here as a
 * pure function). The agent uses it when the API lacks C5's `reviewBoard`/`siteReview`/`reviewHistory` fields
 * (it then derives the inputs from `siteStatusAt`), and the eval stub uses it to serve those fields.
 *
 * Honesty rules: a status is `review` when a condition rule fires, `cannot_assess` when an input is missing or
 * stale (never `ok` by default), `ok` otherwise. Flood categories use NWPS stage against NWPS thresholds only;
 * a USGS stage is never compared with a threshold (datums differ: KRZL1 reads 2.45 ft lower at USGS). No output
 * field is a risk, probability, catch, abundance or safety verdict.
 */

export type Category = "none" | "action" | "minor" | "moderate" | "major";
export const CATEGORY_RANK: Record<Category, number> = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };

export type Thresholds = { action: number | null; minor: number | null; moderate: number | null; major: number | null; lowThreshold?: number | null };

/** NWPS flood category of a stage: the highest threshold the stage is at or above. Null when nothing is known. */
export function categoryOf(stageFt: number | null | undefined, th: Thresholds | null | undefined): Category | null {
  if (stageFt === null || stageFt === undefined || !th) return null;
  const known = (["major", "moderate", "minor", "action"] as const).filter((k) => typeof th[k] === "number");
  if (known.length === 0) return null;
  for (const k of known) if (stageFt >= th[k]!) return k;
  return "none";
}

export const HOUR_MS = 3_600_000;

/** Thresholds the rules use (spec/apps/carp.json `review` block when C5 lands; these are its defaults). */
export const RULES = {
  /** Observed NWPS stage rise over 24 h that needs review, ft. */
  stageRiseFt: 2.0,
  /** Tidal Morgan City (MCGL1) swings about 0.5 ft a cycle; its noise floor is higher. */
  tidalStageRiseFt: 3.0,
  /** Forecast rise over any 24 h span in the first 3 days of the horizon that needs review, ft per day. */
  rapidChangeFtPerDay: 2.0,
  /** Gauge vs forecast stage difference that counts as a source conflict, ft. */
  conflictFt: 1.0,
  /** Observation older than this is stale; the forecast after this many hours since issuance. */
  observationStaleH: 6,
  forecastStaleH: 36,
  /** Freshness bands shown per feed: green <= 2 h, amber <= 6 h, red older (forecast: 24 h, 36 h). */
  observationFreshH: 2,
  forecastFreshH: 24,
  /** Forecast points paired with an observation within this window. */
  pairWindowMs: 30 * 60_000,
} as const;

export type Observation = { observedAt: number; stageFt: number | null; flowKcfs?: number | null; evidenceId: string };
export type ForecastPoint = { validAt: number; stageFt: number | null; flowKcfs?: number | null };
export type Forecast = { issuedAt: number; source: "nwps-live" | "iem-archive" | string; points: ForecastPoint[]; evidenceId: string };
export type AlertRef = { id: string; event: string; evidenceId: string };

export type ReviewInput = {
  site: string;
  asOf: number;
  tidal?: boolean;
  thresholds: Thresholds | null;
  /** Newest NWPS observation known at asOf. */
  observation: Observation | null;
  /** The NWPS observation nearest 24 h before asOf (within 3 h), for the 24 h change. */
  observationDayAgo?: Observation | null;
  /** The forecast in force at asOf. */
  forecast: Forecast | null;
  /** Alerts active at the site at asOf. */
  alerts: AlertRef[];
  /** Fetch-run evidence per feed, cited when a feed itself is the reason (missing, stale). */
  feedEvidence?: { usgs?: string | null; nwps?: string | null; nws?: string | null };
};

export type Rule = "forecast_category" | "active_alert" | "stage_rise" | "rapid_change_forecast" | "source_conflict" | "stale_input" | "missing_input";
export type Reason = {
  rule: Rule;
  value: number | string | null;
  threshold: number | string | null;
  source: string;
  observedAt?: string;
  issuedAt?: string;
  evidenceIds: string[];
  text: string;
};

export type Freshness = { state: "fresh" | "aging" | "stale" | "missing"; band: "green" | "amber" | "red" | "none"; newestAt: string | null; ageHours: number | null };

export type Review = {
  site: string;
  asOf: string;
  status: "review" | "ok" | "cannot_assess";
  reasons: Reason[];
  /** Newest NWPS observation known at asOf. */
  stageFt: number | null;
  observedAt: string | null;
  categoryNow: Category | null;
  categoryPeak: Category | null;
  peak: { at: string; stageFt: number } | null;
  lowWater: boolean;
  change24hFt: number | null;
  freshness: { observation: Freshness; forecast: Freshness };
};

const iso = (ms: number) => new Date(ms).toISOString();
const r2 = (v: number) => Math.round(v * 100) / 100;
const hours = (ms: number) => r2(ms / HOUR_MS);

export function freshness(newestAt: number | null, freshH: number, staleH: number, asOf: number): Freshness {
  if (newestAt === null) return { state: "missing", band: "none", newestAt: null, ageHours: null };
  const age = asOf - newestAt;
  const state = age <= freshH * HOUR_MS ? "fresh" : age <= staleH * HOUR_MS ? "aging" : "stale";
  const band = state === "fresh" ? "green" : state === "aging" ? "amber" : "red";
  return { state, band, newestAt: iso(newestAt), ageHours: hours(age) };
}

/** Highest forecast point at or after `from`. */
export function forecastPeak(points: readonly ForecastPoint[], from = -Infinity): { at: number; stageFt: number } | null {
  let best: { at: number; stageFt: number } | null = null;
  for (const p of points) {
    if (p.stageFt === null || p.validAt < from) continue;
    if (!best || p.stageFt > best.stageFt) best = { at: p.validAt, stageFt: p.stageFt };
  }
  return best;
}

/** Steepest rise over a day-long span (18 to 30 h between points) inside the first 3 days of the forecast, ft/day. */
export function forecastRiseRate(points: readonly ForecastPoint[], from: number): number | null {
  const pts = points.filter((p) => p.stageFt !== null && p.validAt >= from - 6 * HOUR_MS && p.validAt <= from + 3 * 24 * HOUR_MS).sort((a, b) => a.validAt - b.validAt);
  let best: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j]!.validAt - pts[i]!.validAt;
      if (dt < 18 * HOUR_MS || dt > 30 * HOUR_MS) continue;
      const rate = ((pts[j]!.stageFt! - pts[i]!.stageFt!) / dt) * 24 * HOUR_MS;
      if (best === null || rate > best) best = rate;
    }
  }
  return best === null ? null : r2(best);
}

const SEVERITY: Record<Rule, number> = {
  forecast_category: 0,
  active_alert: 1,
  stage_rise: 2,
  rapid_change_forecast: 3,
  source_conflict: 4,
  stale_input: 5,
  missing_input: 6,
};

/** Evaluate one site at one knowledge time. Pure. */
export function review(input: ReviewInput): Review {
  const { site, asOf, thresholds, observation, forecast, alerts } = input;
  const reasons: Reason[] = [];
  const obsFresh = freshness(observation?.observedAt ?? null, RULES.observationFreshH, RULES.observationStaleH, asOf);
  const fcFresh = freshness(forecast?.issuedAt ?? null, RULES.forecastFreshH, RULES.forecastStaleH, asOf);
  const categoryNow = categoryOf(observation?.stageFt, thresholds);
  const peak = forecast ? forecastPeak(forecast.points, asOf) : null;
  const categoryPeak = categoryOf(peak?.stageFt, thresholds);
  const lowWater = typeof thresholds?.lowThreshold === "number" && observation?.stageFt !== null && observation?.stageFt !== undefined && observation.stageFt <= thresholds.lowThreshold;

  // 2. forecast_category: the forecast peak inside the horizon reaches a flood category (NWPS stage and thresholds only).
  if (forecast && peak && categoryPeak && categoryPeak !== "none" && thresholds) {
    const threshold = thresholds[categoryPeak]!;
    reasons.push({
      rule: "forecast_category",
      value: peak.stageFt,
      threshold,
      source: `nwps forecast (${forecast.source})`,
      issuedAt: iso(forecast.issuedAt),
      evidenceIds: [forecast.evidenceId],
      text: `the forecast issued ${iso(forecast.issuedAt)} peaks at ${peak.stageFt} ft at ${iso(peak.at)}, at or above the ${categoryPeak} stage of ${threshold} ft (NWPS stage and thresholds)`,
    });
  }
  // 3. active_alert.
  for (const a of alerts) {
    reasons.push({ rule: "active_alert", value: a.event, threshold: null, source: "nws-alerts", evidenceIds: [a.evidenceId], text: `NWS ${a.event} active at the site` });
  }
  // 1. stage_rise over 24 h (observed NWPS stage, offset-free).
  const dayAgo = input.observationDayAgo ?? null;
  const change24hFt = observation?.stageFt !== null && observation?.stageFt !== undefined && dayAgo?.stageFt !== null && dayAgo?.stageFt !== undefined ? r2(observation.stageFt - dayAgo.stageFt) : null;
  const riseThreshold = input.tidal ? RULES.tidalStageRiseFt : RULES.stageRiseFt;
  if (change24hFt !== null && change24hFt >= riseThreshold && observation && dayAgo) {
    reasons.push({
      rule: "stage_rise",
      value: change24hFt,
      threshold: riseThreshold,
      source: "nwps observed",
      observedAt: iso(observation.observedAt),
      evidenceIds: [observation.evidenceId, dayAgo.evidenceId],
      text: `observed stage rose ${change24hFt} ft in 24 h (${dayAgo.stageFt} ft at ${iso(dayAgo.observedAt)} to ${observation.stageFt} ft at ${iso(observation.observedAt)}), at or above the ${riseThreshold} ft${input.tidal ? " tidal" : ""} threshold`,
    });
  }
  // 4. rapid_change_forecast.
  const rate = forecast ? forecastRiseRate(forecast.points, asOf) : null;
  if (forecast && rate !== null && rate >= RULES.rapidChangeFtPerDay) {
    reasons.push({
      rule: "rapid_change_forecast",
      value: rate,
      threshold: RULES.rapidChangeFtPerDay,
      source: `nwps forecast (${forecast.source})`,
      issuedAt: iso(forecast.issuedAt),
      evidenceIds: [forecast.evidenceId],
      text: `the forecast issued ${iso(forecast.issuedAt)} rises ${rate} ft/day within the next 3 days, at or above ${RULES.rapidChangeFtPerDay} ft/day`,
    });
  }
  // 7. source_conflict: gauge vs the forecast point valid nearest now.
  if (observation?.stageFt !== null && observation?.stageFt !== undefined && forecast) {
    const nearest = forecast.points.filter((p) => p.stageFt !== null && Math.abs(p.validAt - asOf) <= RULES.pairWindowMs).sort((a, b) => Math.abs(a.validAt - asOf) - Math.abs(b.validAt - asOf))[0];
    if (nearest) {
      const diff = r2(observation.stageFt - nearest.stageFt!);
      if (Math.abs(diff) > RULES.conflictFt) {
        reasons.push({
          rule: "source_conflict",
          value: diff,
          threshold: RULES.conflictFt,
          source: "nwps observed vs nwps forecast",
          observedAt: iso(observation.observedAt),
          issuedAt: iso(forecast.issuedAt),
          evidenceIds: [observation.evidenceId, forecast.evidenceId],
          text: `NWPS observed ${observation.stageFt} ft at ${iso(observation.observedAt)} vs forecast ${nearest.stageFt} ft valid ${iso(nearest.validAt)} (issued ${iso(forecast.issuedAt)}): ${diff > 0 ? "+" : ""}${diff} ft, over the ${RULES.conflictFt} ft threshold; neither is blended into the other`,
        });
      }
    }
  }
  // 5. stale_input.
  if (obsFresh.state === "stale" && observation) {
    reasons.push({ rule: "stale_input", value: obsFresh.ageHours, threshold: RULES.observationStaleH, source: "nwps observed", observedAt: iso(observation.observedAt), evidenceIds: [observation.evidenceId, ...(input.feedEvidence?.nwps ? [input.feedEvidence.nwps] : [])], text: `newest NWPS observation is ${obsFresh.ageHours} h old at ${iso(asOf)}, over ${RULES.observationStaleH} h` });
  }
  if (fcFresh.state === "stale" && forecast) {
    reasons.push({ rule: "stale_input", value: fcFresh.ageHours, threshold: RULES.forecastStaleH, source: `nwps forecast (${forecast.source})`, issuedAt: iso(forecast.issuedAt), evidenceIds: [forecast.evidenceId, ...(input.feedEvidence?.nwps ? [input.feedEvidence.nwps] : [])], text: `the newest forecast was issued ${iso(forecast.issuedAt)}, ${fcFresh.ageHours} h before ${iso(asOf)}, over ${RULES.forecastStaleH} h` });
  }
  // 6. missing_input.
  const feedIds = [input.feedEvidence?.nwps, input.feedEvidence?.usgs].filter((v): v is string => typeof v === "string");
  if (!observation) reasons.push({ rule: "missing_input", value: "observation", threshold: null, source: "nwps observed", evidenceIds: feedIds, text: `no NWPS observation known at ${iso(asOf)}` });
  if (!forecast) reasons.push({ rule: "missing_input", value: "forecast", threshold: null, source: "nwps forecast", evidenceIds: feedIds, text: `no forecast known at ${iso(asOf)}` });
  if (!thresholds || categoryOf(0, thresholds) === null) reasons.push({ rule: "missing_input", value: "thresholds", threshold: null, source: "nwps gauge metadata", evidenceIds: feedIds, text: "no NWPS flood categories known for this site; stage is shown without a category" });

  reasons.sort((a, b) => SEVERITY[a.rule] - SEVERITY[b.rule]);
  const fires = reasons.some((r) => ["forecast_category", "active_alert", "stage_rise", "rapid_change_forecast", "source_conflict"].includes(r.rule));
  const status = fires ? "review" : reasons.length > 0 ? "cannot_assess" : "ok";
  return {
    site,
    asOf: iso(asOf),
    status,
    reasons,
    stageFt: observation?.stageFt ?? null,
    observedAt: observation ? iso(observation.observedAt) : null,
    categoryNow,
    categoryPeak,
    peak: peak ? { at: iso(peak.at), stageFt: peak.stageFt } : null,
    lowWater,
    change24hFt,
    freshness: { observation: obsFresh, forecast: fcFresh },
  };
}

/** The rule set of a review as a stable key (status plus the rules that fired, in severity order). */
export function reviewKey(r: Pick<Review, "status" | "reasons">): string {
  return `${r.status}:${[...new Set(r.reasons.map((x) => x.rule))].join(",")}`;
}

export type Transition = { at: string; from: string; to: string; rules: Reason[] };

/** Flips between consecutive samples (sorted by time): each transition carries the rules of the new state. */
export function transitions(samples: readonly Review[]): Transition[] {
  const out: Transition[] = [];
  const sorted = [...samples].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (reviewKey(prev) === reviewKey(cur)) continue;
    out.push({ at: cur.asOf, from: reviewKey(prev), to: reviewKey(cur), rules: cur.reasons });
  }
  return out;
}
