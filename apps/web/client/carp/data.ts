/**
 * Carp GraphQL (C3/C4 fields; C5 review fields when the API has them). Every request goes through the threads
 * API, so it carries the app prefix (`/v1/carp/graphql`) and the db worker's cache.
 */
import { GqlError, gqlRequest } from "client/threads/api";

import { appBBox, type AppConfig } from "shared/apps";

import { forecastAsOf, HOUR, isRiverForecast, thresholdList, usgsSeries, type Alert, type GqlReading, type Site, type SiteStatus, type Snapshot, type VerifyPoint } from "./model";
import { fromC5, historyFromC5, type ReviewHistory, type SiteReview } from "./review";

const SNAPSHOT = `id site product issuedAt ingestedAt source revision validFrom validTo horizonEnd peakStageFt peakAt peakCategory points { validAt stageFt flowKcfs category }`;
const STATUS = `site asOf observation { observedAt ingestedAt source stageFt flowKcfs } stageFt category thresholds { actionFt minorFt moderateFt majorFt } observationFreshness conflicts { kind detail forecastFt observedFt differenceFt } activeAlerts`;
const READING = `param value observedAt origin flag station { id source name lat lon }`;

const iso = (ms: number) => new Date(ms).toISOString();
/** An as-of after anything stored: `siteStatusAt` there gives the newest thresholds held. */
const LATEST = "2100-01-01T00:00:00.000Z";

/** A box around one site, for its readings and alerts. */
export function siteBox(site: Pick<Site, "lat" | "lon">, padDeg = 0.1) {
  return { west: site.lon - padDeg, south: site.lat - padDeg, east: site.lon + padDeg, north: site.lat + padDeg };
}

// ---- board ------------------------------------------------------------------------------------

export type BoardSiteData = {
  status: SiteStatus | null;
  history: Snapshot[];
  replayCoverageStart: string | null;
  /** No NWPS thresholds were stored by the board's time, but some are stored now: they arrived after it. */
  thresholdsLater: boolean;
};
export type BoardData = { asOfMs: number; sites: Record<string, BoardSiteData>; readings: GqlReading[] };

/** One site's board inputs at `$t`: status and the recent issuances. (One query per site keeps each under the API's complexity limit.) */
export const BOARD_SITE_QUERY = `query CarpBoardSite($site: ID!, $t: Time!, $now: Time!) { status: siteStatusAt(site: $site, asOf: $t) { ${STATUS} } forecasts(site: $site, asOf: $t, history: 8) { replayCoverageStart history { ${SNAPSHOT} } } now: siteStatusAt(site: $site, asOf: $now) { thresholds { actionFt minorFt moderateFt majorFt } } }`;
/** USGS readings of every site for the 24 h change (50 h back for the tidal 24 h means). */
export const BOARD_READINGS_QUERY = `query CarpBoardReadings($bbox: BBox!, $from: Time!, $t: Time!) { readings(bbox: $bbox, from: $from, to: $t, params: [STAGE_M, DISCHARGE_CFS]) { ${READING} } }`;

/** The board's inputs at `asOfMs`: each site's status and recent issuances, USGS readings for 24 h change. */
export async function loadBoard(app: AppConfig, sites: readonly Site[], asOfMs: number, signal?: AbortSignal): Promise<BoardData> {
  const t = iso(asOfMs);
  type SiteRaw = { status: SiteStatus | null; forecasts: { replayCoverageStart: string | null; history: Snapshot[] } | null; now: { thresholds: SiteStatus["thresholds"] } | null };
  // The newest thresholds stored, whatever the page clock says (a pinned or replayed clock can sit before them).
  const now = LATEST;
  const [perSite, readings] = await Promise.all([
    Promise.all(sites.map((s) => gqlRequest<SiteRaw>(BOARD_SITE_QUERY, { site: s.lid, t, now }, signal))),
    gqlRequest<{ readings: GqlReading[] }>(BOARD_READINGS_QUERY, { bbox: appBBox(app), from: iso(asOfMs - 50 * HOUR), t }, signal),
  ]);
  const out: BoardData = { asOfMs, sites: {}, readings: readings.readings ?? [] };
  sites.forEach((s, i) => {
    const raw = perSite[i]!;
    out.sites[s.lid] = {
      status: raw.status ?? null,
      history: raw.forecasts?.history ?? [],
      replayCoverageStart: raw.forecasts?.replayCoverageStart ?? null,
      thresholdsLater: thresholdList(raw.status?.thresholds).length === 0 && thresholdList(raw.now?.thresholds).length > 0,
    };
  });
  return out;
}

// ---- C5 review service (optional) -------------------------------------------------------------

/** C5's `SiteReview` fields the client reads (`reasons` are the fired rules; `explanation` is the sentence). */
const REASON_FIELDS = `rule outcome value valueText threshold unit source observedAt issuedAt link explanation`;
const REVIEW_FIELDS = `site status summary observationFreshness reasons { ${REASON_FIELDS} }`;
/** False once the API has answered that it has no `reviewBoard`: the board then derives statuses itself. */
let c5Available: boolean | null = null;
/** `reviewHistory` windows are capped at 31 days by the API. */
const HISTORY_MAX_MS = 31 * 24 * HOUR;
/** Sites per `reviewHistory` document, inside the API's complexity limit (a heavy field per site plus its rows). */
const HISTORY_SITES_PER_REQUEST = 4;
/** Issuances per `forecastVerify` document, inside the API's complexity limit. */
const VERIFY_PER_REQUEST = 8;

/** Whether an error says the field does not exist (schema without C5), rather than a failure worth reporting. */
export function isUnknownField(err: unknown): boolean {
  return err instanceof GqlError && /unknown field|cannot query field|Unknown field/i.test(err.message);
}

/** C5's board at `asOfMs`, or null when the API has no review service yet (or its rows do not fit). */
export async function loadC5Board(asOfMs: number, signal?: AbortSignal): Promise<Record<string, SiteReview> | null> {
  if (c5Available === false) return null;
  try {
    const raw = await gqlRequest<{ reviewBoard: { sites?: unknown[] } | null }>(`query CarpReviewBoard($t: Time!) { reviewBoard(asOf: $t) { sites { ${REVIEW_FIELDS} } } }`, { t: iso(asOfMs) }, signal);
    c5Available = true;
    const out: Record<string, SiteReview> = {};
    for (const row of raw.reviewBoard?.sites ?? []) {
      const r = fromC5(row, asOfMs, "MISSING");
      if (r) out[r.site] = r;
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    if (isUnknownField(err)) c5Available = false;
    else if (!signal?.aborted) console.warn("[carp] reviewBoard failed; statuses derived in the browser", err);
    return null;
  }
}

/**
 * C5's `reviewHistory` of every site over `fromMs`..`toMs` (at most 31 days), a few sites per request: the
 * "what we knew" board then answers any as-of inside the window from memory (`reviewAt`), with no request per
 * scrub step. Null when the API has no review service.
 */
export async function loadC5History(sites: readonly Site[], fromMs: number, toMs: number, signal?: AbortSignal): Promise<Record<string, ReviewHistory> | null> {
  if (c5Available === false) return null;
  const from = Math.max(fromMs, toMs - HISTORY_MAX_MS);
  const out: Record<string, ReviewHistory> = {};
  try {
    const chunks: Site[][] = [];
    for (let i = 0; i < sites.length; i += HISTORY_SITES_PER_REQUEST) chunks.push(sites.slice(i, i + HISTORY_SITES_PER_REQUEST));
    const answers = await Promise.all(
      chunks.map((chunk) => {
        const fields = chunk.map((s, i) => `h${i}: reviewHistory(site: "${s.lid}", from: $from, to: $to) { site from to initial { ${REVIEW_FIELDS} } transitions { at to reasons { ${REASON_FIELDS} } } }`).join(" ");
        return gqlRequest<Record<string, unknown>>(`query CarpReviewHistory($from: Time!, $to: Time!) { ${fields} }`, { from: iso(from), to: iso(toMs) }, signal);
      }),
    );
    c5Available = true;
    for (const raw of answers) {
      for (const row of Object.values(raw)) {
        const h = historyFromC5(row);
        if (h) out[h.site] = h;
      }
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    if (isUnknownField(err)) c5Available = false;
    else if (!signal?.aborted) console.warn("[carp] reviewHistory failed; past statuses are fetched per time", err);
    return null;
  }
}

/** Test hook: forget what the API said about C5. */
export function resetC5Probe(): void {
  c5Available = null;
}

// ---- one site ---------------------------------------------------------------------------------

export type SiteHistory = { history: Snapshot[]; replayCoverageStart: string | null; liveCoverageStart: string | null; snapshotCount: number; thresholdsNow: SiteStatus["thresholds"] };

/** Every issuance known now (up to 60), plus today's thresholds. Fetched once per site and view span. */
export async function loadSiteHistory(site: Site, nowMs: number, signal?: AbortSignal): Promise<SiteHistory> {
  const raw = await gqlRequest<{ forecasts: Omit<SiteHistory, "thresholdsNow">; now: { thresholds: SiteStatus["thresholds"] } }>(
    `query CarpSiteHistory($site: ID!, $now: Time!, $latest: Time!) { forecasts(site: $site, asOf: $now, history: 60) { replayCoverageStart liveCoverageStart snapshotCount history { ${SNAPSHOT} } } now: siteStatusAt(site: $site, asOf: $latest) { thresholds { actionFt minorFt moderateFt majorFt } } }`,
    { site: site.lid, now: iso(nowMs), latest: LATEST },
    signal,
  );
  return { ...raw.forecasts, history: raw.forecasts.history ?? [], thresholdsNow: raw.now?.thresholds ?? null };
}

/** What was known at a time: the site's status then and the alerts in effect. */
export type SiteStatusAt = { status: SiteStatus; alerts: Alert[] };
export type SiteAt = SiteStatusAt & { readings: GqlReading[] };

/** What was known at `asOfMs`: the site's status then and the alerts in effect. */
export async function loadSiteStatusAt(site: Site, asOfMs: number, signal?: AbortSignal): Promise<SiteStatusAt> {
  const raw = await gqlRequest<{ status: SiteStatus; alerts: Alert[] }>(
    `query CarpSiteAt($site: ID!, $t: Time!, $bbox: BBox!) { status: siteStatusAt(site: $site, asOf: $t) { ${STATUS} } alerts(bbox: $bbox, at: $t) { id event severity headline onset expires } }`,
    { site: site.lid, t: iso(asOfMs), bbox: siteBox(site) },
    signal,
  );
  return { status: raw.status, alerts: raw.alerts ?? [] };
}

/** The readings around the site over the view span (USGS stage and discharge, gridpoint weather). Once per site and span. */
export async function loadSiteReadings(site: Site, span: { fromMs: number; toMs: number }, signal?: AbortSignal): Promise<GqlReading[]> {
  const raw = await gqlRequest<{ readings: GqlReading[] }>(
    `query CarpSiteReadings($bbox: BBox!, $from: Time!, $to: Time!) { readings(bbox: $bbox, from: $from, to: $to, params: [STAGE_M, DISCHARGE_CFS, AIR_C, WIND_MS, POP_PCT]) { ${READING} } }`,
    { bbox: siteBox(site), from: iso(span.fromMs), to: iso(span.toMs) },
    signal,
  );
  return raw.readings ?? [];
}

/** Status, alerts and readings at `asOfMs`: the two requests above. */
export async function loadSiteAt(site: Site, asOfMs: number, span: { fromMs: number; toMs: number }, signal?: AbortSignal): Promise<SiteAt> {
  const [at, readings] = await Promise.all([loadSiteStatusAt(site, asOfMs, signal), loadSiteReadings(site, span, signal)]);
  return { ...at, readings };
}

/** NWPS observations paired with an issuance's valid times (6-hourly), the "what happened next" record. */
export async function loadVerify(site: Site, issuedAt: string, signal?: AbortSignal): Promise<VerifyPoint[]> {
  const raw = await gqlRequest<{ forecastVerify: { points: VerifyPoint[] } }>(
    `query CarpVerify($site: ID!, $at: Time!) { forecastVerify(site: $site, issuedAt: $at) { points { validAt forecastFt observedAt observedFt errorFt missing } } }`,
    { site: site.lid, at: issuedAt },
    signal,
  );
  return raw.forecastVerify?.points ?? [];
}

/** The verification pairs of several issuances, a few per request; an issuance the API rejects answers no points. */
export async function loadVerifyMany(site: Site, issuances: readonly string[], signal?: AbortSignal): Promise<Record<string, VerifyPoint[]>> {
  const out: Record<string, VerifyPoint[]> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < issuances.length; i += VERIFY_PER_REQUEST) chunks.push(issuances.slice(i, i + VERIFY_PER_REQUEST));
  await Promise.all(
    chunks.map(async (chunk) => {
      const fields = chunk.map((at, i) => `v${i}: forecastVerify(site: $site, issuedAt: "${at}") { points { validAt forecastFt observedAt observedFt errorFt missing } }`).join(" ");
      try {
        const raw = await gqlRequest<Record<string, { points: VerifyPoint[] } | null>>(`query CarpVerifyMany($site: ID!) { ${fields} }`, { site: site.lid }, signal);
        chunk.forEach((at, i) => (out[at] = raw[`v${i}`]?.points ?? []));
      } catch (err) {
        if (signal?.aborted) throw err;
        // One by one: a single rejected issuance must not empty the others.
        for (const at of chunk) out[at] = await loadVerify(site, at, signal).catch(() => []);
      }
    }),
  );
  return out;
}

/** Board rows' derivation inputs for one site, from the board data. */
export function boardInputs(data: BoardData, site: Site) {
  const d = data.sites[site.lid];
  const history = (d?.history ?? []).filter(isRiverForecast);
  const forecast = forecastAsOf(history, data.asOfMs);
  const previous = forecast ? (history.filter((s) => Date.parse(s.issuedAt) < Date.parse(forecast.issuedAt)).sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0] ?? null) : null;
  return { status: d?.status ?? null, forecast, previous, usgs: usgsSeries(data.readings, site), thresholdsLater: d?.thresholdsLater ?? false };
}
