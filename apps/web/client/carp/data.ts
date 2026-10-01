/**
 * Carp GraphQL (C3/C4 fields; C5 review fields when the API has them). Every request goes through the threads
 * API, so it carries the app prefix (`/v1/carp/graphql`) and the db worker's cache.
 */
import { GqlError, gqlRequest } from "client/threads/api";

import { appBBox, type AppConfig } from "shared/apps";

import { forecastAsOf, HOUR, isRiverForecast, usgsSeries, type Alert, type GqlReading, type Site, type SiteStatus, type Snapshot, type VerifyPoint } from "./model";
import { fromC5, type SiteReview } from "./review";

const SNAPSHOT = `id site product issuedAt ingestedAt source revision validFrom validTo horizonEnd peakStageFt peakAt peakCategory points { validAt stageFt flowKcfs category }`;
const STATUS = `site asOf observation { observedAt ingestedAt source stageFt flowKcfs } stageFt category thresholds { actionFt minorFt moderateFt majorFt } observationFreshness conflicts { kind detail forecastFt observedFt differenceFt } activeAlerts`;
const READING = `param value observedAt origin flag station { id source name lat lon }`;

const iso = (ms: number) => new Date(ms).toISOString();

/** A box around one site, for its readings and alerts. */
export function siteBox(site: Pick<Site, "lat" | "lon">, padDeg = 0.1) {
  return { west: site.lon - padDeg, south: site.lat - padDeg, east: site.lon + padDeg, north: site.lat + padDeg };
}

// ---- board ------------------------------------------------------------------------------------

export type BoardSiteData = { status: SiteStatus | null; history: Snapshot[]; replayCoverageStart: string | null };
export type BoardData = { asOfMs: number; sites: Record<string, BoardSiteData>; readings: GqlReading[] };

/** One site's board inputs at `$t`: status and the recent issuances. (One query per site keeps each under the API's complexity limit.) */
export const BOARD_SITE_QUERY = `query CarpBoardSite($site: ID!, $t: Time!) { status: siteStatusAt(site: $site, asOf: $t) { ${STATUS} } forecasts(site: $site, asOf: $t, history: 8) { replayCoverageStart history { ${SNAPSHOT} } } }`;
/** USGS readings of every site for the 24 h change (50 h back for the tidal 24 h means). */
export const BOARD_READINGS_QUERY = `query CarpBoardReadings($bbox: BBox!, $from: Time!, $t: Time!) { readings(bbox: $bbox, from: $from, to: $t, params: [STAGE_M, DISCHARGE_CFS]) { ${READING} } }`;

/** The board's inputs at `asOfMs`: each site's status and recent issuances, USGS readings for 24 h change. */
export async function loadBoard(app: AppConfig, sites: readonly Site[], asOfMs: number, signal?: AbortSignal): Promise<BoardData> {
  const t = iso(asOfMs);
  type SiteRaw = { status: SiteStatus | null; forecasts: { replayCoverageStart: string | null; history: Snapshot[] } | null };
  const [perSite, readings] = await Promise.all([
    Promise.all(sites.map((s) => gqlRequest<SiteRaw>(BOARD_SITE_QUERY, { site: s.lid, t }, signal))),
    gqlRequest<{ readings: GqlReading[] }>(BOARD_READINGS_QUERY, { bbox: appBBox(app), from: iso(asOfMs - 50 * HOUR), t }, signal),
  ]);
  const out: BoardData = { asOfMs, sites: {}, readings: readings.readings ?? [] };
  sites.forEach((s, i) => {
    const raw = perSite[i]!;
    out.sites[s.lid] = { status: raw.status ?? null, history: raw.forecasts?.history ?? [], replayCoverageStart: raw.forecasts?.replayCoverageStart ?? null };
  });
  return out;
}

// ---- C5 review service (optional) -------------------------------------------------------------

const REVIEW_FIELDS = `site status reasons { rule value threshold source observedAt issuedAt link text }`;
/** False once the API has answered that it has no `reviewBoard`: the board then derives statuses itself. */
let c5Available: boolean | null = null;

/** Whether an error says the field does not exist (schema without C5), rather than a failure worth reporting. */
export function isUnknownField(err: unknown): boolean {
  return err instanceof GqlError && /unknown field|cannot query field|Unknown field/i.test(err.message);
}

/** C5's board at `asOfMs`, or null when the API has no review service yet (or its rows do not fit). */
export async function loadC5Board(asOfMs: number, signal?: AbortSignal): Promise<Record<string, SiteReview> | null> {
  if (c5Available === false) return null;
  try {
    const raw = await gqlRequest<{ reviewBoard: unknown[] }>(`query CarpReviewBoard($t: Time!) { reviewBoard(asOf: $t) { ${REVIEW_FIELDS} } }`, { t: iso(asOfMs) }, signal);
    c5Available = true;
    const out: Record<string, SiteReview> = {};
    for (const row of raw.reviewBoard ?? []) {
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

/** Test hook: forget what the API said about C5. */
export function resetC5Probe(): void {
  c5Available = null;
}

// ---- one site ---------------------------------------------------------------------------------

export type SiteHistory = { history: Snapshot[]; replayCoverageStart: string | null; liveCoverageStart: string | null; snapshotCount: number; thresholdsNow: SiteStatus["thresholds"] };

/** Every issuance known now (up to 60), plus today's thresholds. Fetched once per site and view span. */
export async function loadSiteHistory(site: Site, nowMs: number, signal?: AbortSignal): Promise<SiteHistory> {
  const raw = await gqlRequest<{ forecasts: Omit<SiteHistory, "thresholdsNow">; now: { thresholds: SiteStatus["thresholds"] } }>(
    `query CarpSiteHistory($site: ID!, $now: Time!) { forecasts(site: $site, asOf: $now, history: 60) { replayCoverageStart liveCoverageStart snapshotCount history { ${SNAPSHOT} } } now: siteStatusAt(site: $site, asOf: $now) { thresholds { actionFt minorFt moderateFt majorFt } } }`,
    { site: site.lid, now: iso(nowMs) },
    signal,
  );
  return { ...raw.forecasts, history: raw.forecasts.history ?? [], thresholdsNow: raw.now?.thresholds ?? null };
}

export type SiteAt = { status: SiteStatus; alerts: Alert[]; readings: GqlReading[] };

/** What was known at `asOfMs` (status, alerts in effect) and the readings of the view span. */
export async function loadSiteAt(site: Site, asOfMs: number, span: { fromMs: number; toMs: number }, signal?: AbortSignal): Promise<SiteAt> {
  const raw = await gqlRequest<{ status: SiteStatus; alerts: Alert[]; readings: GqlReading[] }>(
    `query CarpSiteAt($site: ID!, $t: Time!, $bbox: BBox!, $from: Time!, $to: Time!) { status: siteStatusAt(site: $site, asOf: $t) { ${STATUS} } alerts(bbox: $bbox, at: $t) { id event severity headline onset expires } readings(bbox: $bbox, from: $from, to: $to, params: [STAGE_M, DISCHARGE_CFS, AIR_C, WIND_MS, POP_PCT]) { ${READING} } }`,
    { site: site.lid, t: iso(asOfMs), bbox: siteBox(site), from: iso(span.fromMs), to: iso(span.toMs) },
    signal,
  );
  return { status: raw.status, alerts: raw.alerts ?? [], readings: raw.readings ?? [] };
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

/** Board rows' derivation inputs for one site, from the board data. */
export function boardInputs(data: BoardData, site: Site) {
  const d = data.sites[site.lid];
  const history = (d?.history ?? []).filter(isRiverForecast);
  const forecast = forecastAsOf(history, data.asOfMs);
  const previous = forecast ? (history.filter((s) => Date.parse(s.issuedAt) < Date.parse(forecast.issuedAt)).sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))[0] ?? null) : null;
  return { status: d?.status ?? null, forecast, previous, usgs: usgsSeries(data.readings, site) };
}
