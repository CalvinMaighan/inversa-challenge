/**
 * River tools for conditions apps (carp): `site_status`, `river_readings`, `river_forecast`, `forecast_verify`,
 * `review_history`, `weather_forecast`. Each makes one POST to the app's GraphQL (two for forecast_verify
 * without an issuance time), with `feeds` in the same document. Every value carries its unit and source; stage
 * is NWPS feet (USGS metres converted, on the USGS datum), flow is kcfs at NWPS and cfs at USGS, never blended.
 * `asOf` is knowledge time: what the store knew then (live rows by ingestion, archive rows by issuance).
 *
 * `site_status` and `review_history` code to C5's `reviewBoard` / `reviewHistory` and fall back to
 * `siteStatusAt` plus the TS rule mirror (`review.ts`) on an API that lacks them.
 */

import { z } from "zod";

import type { CapabilityContext, CapabilityOutput, Evidence } from "@/server/agent/runtime/registry";
import { evidence, readingKey } from "@/server/agent/tools/evidence";
import { GraphqlError, gqlWithFeeds, type GqlFeedState } from "@/server/agent/tools/gql";
import { categoryOf, forecastPeak, review, RULES, transitions, type Category, type Reason, type Review, type Thresholds } from "@/server/agent/tools/review";
import { feedsFor, given, givenList, givenTime, HOUR_MS, localTime, lookbackWindow, output, timeSchema } from "@/server/agent/tools/shared";
import { carpSites, resolveSites, sitesBox, type SiteRef } from "@/server/agent/tools/sites";
import { conditionsViews, MAX_HIGHLIGHT, withView, type ReadingRow, type ToolViewData } from "@/server/agent/tools/views";
import type { BBox } from "@/shared/agent/events";
import type { SeriesView, TableView } from "@/shared/agent/results";
import { appBBox, type AppConfig } from "@/shared/apps";

const FT_PER_M = 1 / 0.3048;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const ms = (t: string) => Date.parse(t);
const iso = (t: number) => new Date(t).toISOString();
const hoursBetween = (a: number, b: number) => r1((a - b) / HOUR_MS);

/** The forecast lid is the evidence key; the issued time keeps versions apart. */
export const forecastId = (lid: string, issuedAt: string | number) => `forecast:${lid}:${typeof issuedAt === "number" ? issuedAt : ms(issuedAt)}`;
/** An NWPS observation is cited like a reading at the lid, on the NWPS datum. */
export const nwpsObservationId = (lid: string, observedAt: string) => `reading:${readingKey(lid, "stage_m", observedAt, "measured")}`;

const provenance = (source: string) => (source.toUpperCase() === "IEM_ARCHIVE" ? "iem-archive" : source.toUpperCase() === "NWS_GRIDPOINT" ? "nws-gridpoint" : "nwps-live");
const feedOf = (source: string) => (provenance(source) === "iem-archive" ? "iem" : provenance(source) === "nws-gridpoint" ? "nws-forecast" : "nwps");

const sitesInput = z.array(z.string().min(2).max(80)).max(16).optional().describe("Sites by NWPS id (SMML1), town (Krotz Springs), name, or a preset ('Atchafalaya' = the basin's four). Omit for all eight.");
const asOfInput = timeSchema.optional().describe("Knowledge time (RFC 3339): answer from what was known at that moment. Default: the reference time (live).");

// ---------------------------------------------------------------- GraphQL shapes (C3)

const SNAPSHOT_FIELDS = "id site product issuedAt ingestedAt source revision validFrom validTo horizonEnd peakStageFt peakAt peakCategory points { validAt stageFt flowKcfs category }";

type GqlPoint = { validAt: string; stageFt: number | null; flowKcfs: number | null; category: string | null };
type GqlSnapshot = {
  id: string;
  site: string;
  product: string;
  issuedAt: string;
  ingestedAt: string;
  source: string;
  revision: number;
  validFrom: string | null;
  validTo: string | null;
  horizonEnd: string | null;
  peakStageFt: number | null;
  peakAt: string | null;
  peakCategory: string | null;
  points: GqlPoint[];
};
type GqlForecastView = { site: string; asOf: string; snapshot: GqlSnapshot | null; history: GqlSnapshot[]; replayCoverageStart: string | null; liveCoverageStart: string | null; snapshotCount: number };
type GqlSiteStatus = {
  site: string;
  asOf: string;
  observation: { observedAt: string; ingestedAt: string; source: string; stageFt: number | null; flowKcfs: number | null } | null;
  stageFt: number | null;
  category: string | null;
  thresholds: { actionFt: number | null; minorFt: number | null; moderateFt: number | null; majorFt: number | null } | null;
  observationFreshness: string;
  forecastFreshness: string;
  forecast: GqlSnapshot | null;
  forecastNow: GqlPoint | null;
  conflicts: { kind: string; detail: string; forecastFt: number | null; observedFt: number | null; differenceFt: number | null }[];
  activeAlerts: number;
};

const SITE_STATUS_FIELDS = `site asOf observation { observedAt ingestedAt source stageFt flowKcfs } stageFt category thresholds { actionFt minorFt moderateFt majorFt } observationFreshness forecastFreshness forecast { ${SNAPSHOT_FIELDS} } forecastNow { validAt stageFt flowKcfs category } conflicts { kind detail forecastFt observedFt differenceFt } activeAlerts`;

/** `s0..sN` aliases: one `siteStatusAt` per site at `$asOf`, and `p<i>` at `$asOf24` when given. */
function siteStatusQuery(n: number, withDayAgo: boolean): string {
  const vars = [...Array(n).keys()].map((i) => `$s${i}: ID!`).join(", ");
  const fields = [...Array(n).keys()]
    .flatMap((i) => [`s${i}: siteStatusAt(site: $s${i}, asOf: $asOf, conflictFt: $conflictFt) { ${SITE_STATUS_FIELDS} }`, ...(withDayAgo ? [`p${i}: siteStatusAt(site: $s${i}, asOf: $asOf24, conflictFt: $conflictFt) { ${SITE_STATUS_FIELDS} }`] : [])])
    .join("\n  ");
  return `query AgentSiteStatus($asOf: Time!, ${withDayAgo ? "$asOf24: Time!, " : ""}$conflictFt: Float, ${vars}) {\n  ${fields}\n  feeds { ...FeedFields }\n}\n`;
}

/** `f<i>`: the forecast view per site; `t<i>`: the site's thresholds and observed category at the same time (one POST). */
function forecastsQuery(n: number): string {
  const vars = [...Array(n).keys()].map((i) => `$s${i}: ID!`).join(", ");
  const fields = [...Array(n).keys()]
    .flatMap((i) => [
      `f${i}: forecasts(site: $s${i}, asOf: $asOf, history: $history) { site asOf snapshot { ${SNAPSHOT_FIELDS} } history { ${SNAPSHOT_FIELDS} } replayCoverageStart liveCoverageStart snapshotCount }`,
      `t${i}: siteStatusAt(site: $s${i}, asOf: $asOf) { site thresholds { actionFt minorFt moderateFt majorFt } stageFt category observation { observedAt stageFt } }`,
    ])
    .join("\n  ");
  return `query AgentForecasts($asOf: Time!, $history: Int, ${vars}) {\n  ${fields}\n  feeds { ...FeedFields }\n}\n`;
}

function siteVars(sites: readonly SiteRef[]): Record<string, string> {
  return Object.fromEntries(sites.map((s, i) => [`s${i}`, s.lid]));
}

const thresholdsOf = (t: GqlSiteStatus["thresholds"] | GqlForecastThresholds | null): Thresholds | null =>
  t ? { action: t.actionFt ?? null, minor: t.minorFt ?? null, moderate: t.moderateFt ?? null, major: t.majorFt ?? null } : null;
type GqlForecastThresholds = { actionFt: number | null; minorFt: number | null; moderateFt: number | null; majorFt: number | null };

const lowerCat = (c: string | null | undefined): Category | null => (c ? (c.toLowerCase() as Category) : null);

function snapshotRow(app: AppConfig, snap: GqlSnapshot, asOf: number, thresholds: Thresholds | null) {
  const peak = forecastPeak(snap.points.map((p) => ({ validAt: ms(p.validAt), stageFt: p.stageFt })));
  const peakCategory = lowerCat(snap.peakCategory) ?? categoryOf(peak?.stageFt ?? null, thresholds);
  const age = hoursBetween(asOf, ms(snap.issuedAt));
  return {
    cite: `[e:${forecastId(snap.site, snap.issuedAt)}]`,
    evidenceId: forecastId(snap.site, snap.issuedAt),
    site: snap.site,
    issuedAt: snap.issuedAt,
    issuedLocal: localTime(app, snap.issuedAt),
    issuance: `forecast issued ${localTime(app, snap.issuedAt)} (${provenance(snap.source)}) [e:${forecastId(snap.site, snap.issuedAt)}]`,
    headline: `${snap.site}: forecast issued ${localTime(app, snap.issuedAt)} (${provenance(snap.source)}, ${age} hours old${age > RULES.forecastStaleH ? ", stale" : ""})${peak ? `, peak ${peak.stageFt} ft at ${localTime(app, peak.at)}, category ${peakCategory ?? "unknown"}` : ""} [e:${forecastId(snap.site, snap.issuedAt)}]`,
    provenance: provenance(snap.source),
    product: snap.product,
    ingestedAt: snap.ingestedAt,
    ageHoursAtAsOf: age,
    age: `${age} hours old${age > RULES.forecastStaleH ? " (stale: over 36 hours)" : ""}`,
    stale: age > RULES.forecastStaleH,
    validFrom: snap.validFrom,
    validTo: snap.validTo,
    horizonDays: snap.validFrom && snap.validTo ? r1((ms(snap.validTo) - ms(snap.validFrom)) / (24 * HOUR_MS)) : null,
    peak: peak ? { at: iso(peak.at), atLocal: localTime(app, peak.at), stageFt: peak.stageFt, category: peakCategory ?? "unknown" } : null,
    pointCount: snap.points.length,
  };
}

/** Points for the model: 6-hourly for the first 3 days, then daily, at most 24 rows. */
function thinPoints(points: readonly GqlPoint[], from: number): { at: string; stageFt: number | null; flowKcfs: number | null; category: string | null }[] {
  const sorted = [...points].sort((a, b) => ms(a.validAt) - ms(b.validAt));
  const out: typeof sorted = [];
  for (const p of sorted) {
    const t = ms(p.validAt);
    const dayOf = Math.floor((t - from) / (24 * HOUR_MS));
    if (dayOf < 3 || t === ms(sorted[sorted.length - 1]!.validAt) || new Date(t).getUTCHours() === 12) out.push(p);
  }
  return out.slice(0, 24).map((p) => ({ at: p.validAt, stageFt: p.stageFt, flowKcfs: p.flowKcfs, category: p.category ? p.category.toLowerCase() : null }));
}

// ---------------------------------------------------------------- river_forecast

const riverForecastInput = z.object({
  sites: sitesInput,
  asOf: asOfInput,
  issuedAt: timeSchema.optional().describe("Return the issuance made at this time (exact issuance time from a previous result) instead of the one current at asOf."),
  previous: z.number().int().min(0).max(10).optional().describe("Also return this many earlier issuances for revision comparisons (default 0; use 1 for 'how did it change from yesterday')."),
});

export const riverForecast = {
  name: "river_forecast",
  description:
    "NWPS river forecast issuances per site, bitemporal: the issuance current at asOf (what was known then), its issuance time, provenance (nwps-live snapshot or iem-archive copy), valid range, 6-hourly stage points (ft) and flow (kcfs) where NWPS gives it, peak and peak flood category against the site's NWPS thresholds, horizon, and age (stale after 36 h). previous=N adds the N earlier issuances with the change in peak. Cite each issuance as its forecast:<lid>:<issued ms> id.",
  inputSchema: riverForecastInput,
  async execute(input: z.infer<typeof riverForecastInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const sites = resolveSites(ctx.app, givenList(input.sites));
    const asOfText = givenTime(input.asOf);
    const asOf = asOfText ? ms(asOfText) : ctx.now.getTime();
    const previous = input.previous ?? 0;
    const issuedAtText = givenTime(input.issuedAt);
    const history = Math.min(60, (issuedAtText ? 30 : 1) + previous);
    const data = await gqlWithFeeds<Record<string, GqlForecastView> & { feeds: GqlFeedState[] }>("AgentForecasts", forecastsQuery(sites.length), { ...siteVars(sites), asOf: iso(asOf), history }, ctx);
    const evidenceRows: Evidence[] = [];
    const series: SeriesView[] = [];
    const rows = sites.map((site, i) => {
      const view = data[`f${i}`]!;
      const status = data[`t${i}`] as unknown as Pick<GqlSiteStatus, "thresholds" | "stageFt" | "category" | "observation"> | undefined;
      const th = thresholdsOf(status?.thresholds ?? null);
      let current = view.snapshot;
      let earlier = view.history.filter((s) => s.issuedAt !== current?.issuedAt);
      if (issuedAtText) {
        const wanted = ms(issuedAtText);
        const hit = view.history.find((s) => Math.abs(ms(s.issuedAt) - wanted) < 60_000);
        if (hit) {
          current = hit;
          earlier = view.history.filter((s) => ms(s.issuedAt) < ms(hit.issuedAt));
        }
      }
      const thresholds = th;
      const currentRow = current ? snapshotRow(ctx.app, current, asOf, thresholds) : null;
      if (current) evidenceRows.push(evidence("forecast", forecastId(site.lid, current.issuedAt).slice("forecast:".length), `${site.lid} forecast issued ${current.issuedAt} (${provenance(current.source)})`, feedOf(current.source)));
      const prevRows = earlier.slice(0, previous).map((s) => {
        evidenceRows.push(evidence("forecast", forecastId(site.lid, s.issuedAt).slice("forecast:".length), `${site.lid} forecast issued ${s.issuedAt} (${provenance(s.source)})`, feedOf(s.source)));
        const row = snapshotRow(ctx.app, s, asOf, thresholds);
        const peakDelta = currentRow?.peak && row.peak ? r2(currentRow.peak.stageFt - row.peak.stageFt) : null;
        const shared = current ? sharedPointDelta(current.points, s.points) : null;
        const change = peakDelta === null ? "peak not comparable" : peakDelta === 0 ? "peak unchanged" : `current peak ${Math.abs(peakDelta)} ft ${peakDelta > 0 ? "higher" : "lower"} than this earlier issuance`;
        return { ...row, versusCurrent: { peakDeltaFt: peakDelta, meanDeltaAtSharedValidTimesFt: shared, change } };
      });
      if (current) {
        series.push({
          view: "series",
          title: `Forecast stage · ${site.short}`,
          unit: "ft",
          series: [current, ...earlier.slice(0, previous)].map((s) => ({
            label: `issued ${localTime(ctx.app, s.issuedAt)} (${provenance(s.source)})`,
            evidenceId: forecastId(site.lid, s.issuedAt),
            points: s.points.map((p) => [ms(p.validAt), p.stageFt] as [number, number | null]),
          })),
        });
      }
      return {
        site: site.lid,
        name: site.name,
        basin: site.basin || null,
        asOf: iso(asOf),
        ...(currentRow
          ? { current: { ...currentRow, points: thinPoints(current!.points, asOf) } }
          : { current: null, missing: `no forecast known for ${site.lid} at ${iso(asOf)} (replay coverage starts ${view.replayCoverageStart ?? "unknown"})` }),
        previousIssuances: prevRows,
        thresholdsFt: thresholds ? { ...thresholds, source: "NWPS gauge metadata (flood categories: at or above)" } : null,
        observedNow: status?.observation ? { stageFt: status.observation.stageFt, at: status.observation.observedAt, category: lowerCat(status.category) ?? categoryOf(status.observation.stageFt, thresholds), source: "nwps" } : null,
        knownIssuancesAtAsOf: view.snapshotCount,
        replayCoverageStart: view.replayCoverageStart,
        liveCoverageStart: view.liveCoverageStart,
        siteNote: site.note || null,
      };
    });
    const sources = new Set(rows.flatMap((r) => [r.current?.provenance === "iem-archive" ? "iem" : "nwps", ...r.previousIssuances.map((p) => (p.provenance === "iem-archive" ? "iem" : "nwps"))]));
    const feeds = feedsFor(data.feeds, sources, ["nwps", "iem"]);
    const [first, ...rest] = series;
    const view: ToolViewData = first ? { result: first, more: rest, highlight: evidenceRows.slice(0, MAX_HIGHLIGHT).map((e) => e.id), bbox: sitesBox(sites) } : { result: rowsTable("River forecast", rows), bbox: sitesBox(sites) };
    return withView(
      output(
        {
          asOf: iso(asOf),
          asOfLocal: localTime(ctx.app, asOf),
          note: "A forecast is a deterministic stage path from the River Forecast Center, not a probability: there is no percent chance of flooding in it. Flood categories compare NWPS stage with NWPS thresholds only.",
          say: "Start each site's forecast sentence with its `headline`, copied verbatim (it carries the word 'issued', the provenance, the age and the marker); do the same for each previous issuance.",
          rows,
        },
        evidenceRows,
        feeds,
        rows.filter((r) => r.current).length,
      ),
      view,
    );
  },
};

/** A plain table of per-site rows (site, name, and what is missing), for a result with nothing to chart. */
function rowsTable(title: string, rows: readonly Record<string, unknown>[]): TableView {
  return {
    view: "table",
    title,
    columns: [
      { key: "site", label: "Site", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "note", label: "Note", kind: "text" },
    ],
    rows: rows.map((r) => ({ evidenceId: String((r as { evidenceId?: string }).evidenceId ?? `forecast:${String(r.site)}:0`), site: String(r.site ?? ""), name: String(r.name ?? ""), note: String(r.missing ?? r.error ?? "") })),
  };
}

function sharedPointDelta(a: readonly GqlPoint[], b: readonly GqlPoint[]): number | null {
  const byTime = new Map(b.filter((p) => p.stageFt !== null).map((p) => [p.validAt, p.stageFt!]));
  const deltas = a.filter((p) => p.stageFt !== null && byTime.has(p.validAt)).map((p) => p.stageFt! - byTime.get(p.validAt)!);
  return deltas.length ? r2(deltas.reduce((s, d) => s + d, 0) / deltas.length) : null;
}

// ---------------------------------------------------------------- site_status

const siteStatusInput = z.object({ sites: sitesInput, asOf: asOfInput });

type StatusRow = {
  site: string;
  name: string;
  basin: string | null;
  status: Review["status"];
  needsReview: boolean;
  reasons: (Reason & { cite: string })[];
  categoryNow: Category | null;
  categoryPeak: Category | null;
  peak: Review["peak"];
  lowWater: boolean;
  stageFt: number | null;
  stageObservedAt: string | null;
  change24hFt: number | null;
  forecastIssuedAt: string | null;
  forecastProvenance: string | null;
  activeAlerts: number;
  feeds: Record<string, { state: string; newestAt: string | null; ageHours: number | null; cite: string | null }>;
  thresholds: Thresholds | null;
  siteNote: string | null;
  evidenceIds: string[];
};

/** C5's `reviewBoard`, when the API has it. Rows are read defensively: the engine owns the exact shape. */
type GqlReviewSite = { site: string; status: string; reasons: (Partial<Reason> & { link?: string | null })[]; categoryNow?: string | null; categoryPeak?: string | null; peak?: { at: string; stageFt: number } | null; lowWater?: boolean; change24hFt?: number | null; freshness?: Review["freshness"] };
const REVIEW_BOARD_QUERY = `query AgentReviewBoard($asOf: Time) {
  reviewBoard(asOf: $asOf) { asOf sites { site status reasons { rule value threshold source observedAt issuedAt evidenceIds link text } categoryNow categoryPeak peak { at stageFt } lowWater change24hFt freshness { observation { state band newestAt ageHours } forecast { state band newestAt ageHours } } } }
  feeds { ...FeedFields }
}
`;

const isMissingField = (error: unknown) => error instanceof GraphqlError && /unknown field|cannot query field|unknown operation|not_conditions_app|Unknown field/i.test(error.message);

async function reviewsAt(sites: readonly SiteRef[], asOf: number, ctx: CapabilityContext): Promise<{ reviews: Review[]; feeds: GqlFeedState[]; engine: "api" | "mirror" }> {
  // C5 first.
  try {
    const data = await gqlWithFeeds<{ reviewBoard: { asOf: string; sites: GqlReviewSite[] }; feeds: GqlFeedState[] }>("AgentReviewBoard", REVIEW_BOARD_QUERY, { asOf: iso(asOf) }, ctx);
    const wanted = new Set(sites.map((s) => s.lid));
    const reviews = data.reviewBoard.sites
      .filter((r) => wanted.has(r.site))
      .map(
        (r): Review => ({
          site: r.site,
          asOf: data.reviewBoard.asOf,
          status: (r.status as Review["status"]) ?? "cannot_assess",
          reasons: r.reasons.map((x) => ({ rule: x.rule as Reason["rule"], value: x.value ?? null, threshold: x.threshold ?? null, source: x.source ?? "", observedAt: x.observedAt, issuedAt: x.issuedAt, evidenceIds: x.evidenceIds ?? (x.link ? [x.link] : []), text: x.text ?? "" })),
          stageFt: (r as { stageFt?: number | null }).stageFt ?? null,
          observedAt: (r as { observedAt?: string | null }).observedAt ?? r.freshness?.observation?.newestAt ?? null,
          categoryNow: lowerCat(r.categoryNow),
          categoryPeak: lowerCat(r.categoryPeak),
          peak: r.peak ?? null,
          lowWater: r.lowWater ?? false,
          change24hFt: r.change24hFt ?? null,
          freshness: r.freshness ?? { observation: { state: "missing", band: "none", newestAt: null, ageHours: null }, forecast: { state: "missing", band: "none", newestAt: null, ageHours: null } },
        }),
      );
    return { reviews, feeds: data.feeds, engine: "api" };
  } catch (error) {
    if (!isMissingField(error)) throw error;
  }
  // Fallback: C3 `siteStatusAt` now and 24 h ago, rules mirrored here.
  const data = await gqlWithFeeds<Record<string, GqlSiteStatus> & { feeds: GqlFeedState[] }>("AgentSiteStatus", siteStatusQuery(sites.length, true), { ...siteVars(sites), asOf: iso(asOf), asOf24: iso(asOf - 24 * HOUR_MS), conflictFt: RULES.conflictFt }, ctx);
  const fetchId = (source: string) => data.feeds.find((f) => f.source === source)?.lastFetchRunId ?? null;
  const feedEvidence = { usgs: fetchId("usgs") ? `fetch:${fetchId("usgs")}` : null, nwps: fetchId("nwps") ? `fetch:${fetchId("nwps")}` : null, nws: fetchId("nws-alerts") ? `fetch:${fetchId("nws-alerts")}` : null };
  const reviews = sites.map((site, i) => reviewFromStatus(site, data[`s${i}`]!, data[`p${i}`] ?? null, asOf, feedEvidence));
  return { reviews, feeds: data.feeds, engine: "mirror" };
}

/**
 * NWPS low-water thresholds (gauge metadata `lowThreshold`, ft), which C3's `siteStatusAt` does not carry.
 * From `api/fixtures/nwps/<lid>.json`; a site missing here has none defined.
 */
const LOW_WATER_FT: Record<string, number> = { MLUL1: 19 };

/** `review()` over a C3 status row. Alerts come as a count only, so each counts as one `active_alert` reason cited by the alerts fetch. */
function reviewFromStatus(site: SiteRef, status: GqlSiteStatus, dayAgo: GqlSiteStatus | null, asOf: number, feedEvidence: { usgs: string | null; nwps: string | null; nws: string | null }): Review {
  const obs = status.observation;
  const prev = dayAgo?.observation;
  const prevClose = prev && Math.abs(ms(prev.observedAt) - (asOf - 24 * HOUR_MS)) <= 3 * HOUR_MS ? prev : null;
  return review({
    site: site.lid,
    asOf,
    tidal: site.tidal,
    thresholds: thresholdsOf(status.thresholds) ? { ...thresholdsOf(status.thresholds)!, lowThreshold: LOW_WATER_FT[site.lid] ?? null } : null,
    observation: obs ? { observedAt: ms(obs.observedAt), stageFt: obs.stageFt, flowKcfs: obs.flowKcfs, evidenceId: nwpsObservationId(site.lid, obs.observedAt) } : null,
    observationDayAgo: prevClose ? { observedAt: ms(prevClose.observedAt), stageFt: prevClose.stageFt, evidenceId: nwpsObservationId(site.lid, prevClose.observedAt) } : null,
    forecast: status.forecast ? { issuedAt: ms(status.forecast.issuedAt), source: provenance(status.forecast.source), points: status.forecast.points.map((p) => ({ validAt: ms(p.validAt), stageFt: p.stageFt, flowKcfs: p.flowKcfs })), evidenceId: forecastId(site.lid, status.forecast.issuedAt) } : null,
    alerts: Array.from({ length: status.activeAlerts }, (_, i) => ({ id: `${site.lid}-active-${i + 1}`, event: "alert (see the alerts tool for the product)", evidenceId: feedEvidence.nws ?? `fetch:nws-alerts` })),
    feedEvidence,
  });
}

export const siteStatus = {
  name: "site_status",
  description:
    "Per-site operational review status for the configured locations, from data known at asOf (default now): status review / ok / cannot_assess with each reason (rule, value, threshold, source, evidence ids, plain text), flood category now and at the forecast peak (NWPS stage against NWPS thresholds only), low-water flag, 24 h stage change, and per-feed freshness (green <= 2 h, amber <= 6 h, red older; forecast stale after 36 h). Start here for 'which locations need review', 'why is X flagged', 'what did we know at T'. Cite the evidence ids in each reason.",
  inputSchema: siteStatusInput,
  async execute(input: z.infer<typeof siteStatusInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const sites = resolveSites(ctx.app, givenList(input.sites));
    const asOfText = givenTime(input.asOf);
    const asOf = asOfText ? ms(asOfText) : ctx.now.getTime();
    const { reviews, feeds: rawFeeds, engine } = await reviewsAt(sites, asOf, ctx);
    const feedRow = (source: string) => rawFeeds.find((f) => f.source === source) ?? null;
    const feedCite = (source: string) => (feedRow(source)?.lastFetchRunId ? `[e:fetch:${feedRow(source)!.lastFetchRunId}]` : null);
    const feedAge = (source: string) => {
      const f = feedRow(source);
      const newest = f?.newestObservedAt ?? null;
      return { state: f ? f.state.toLowerCase() : "unknown", newestAt: newest, ageHours: newest ? hoursBetween(asOf, ms(newest)) : null, cite: feedCite(source) };
    };
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    const add = (row: Evidence) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      evidenceRows.push(row);
    };
    const replaying = asOf < ctx.now.getTime() - 15 * 60_000;
    const asOfPhrase = replaying ? `As of ${localTime(ctx.app, asOf)}, we knew: ` : "";
    const rows: (StatusRow & { summary: string })[] = reviews.map((r) => {
      const site = sites.find((s) => s.lid === r.site)!;
      const ids = new Set<string>();
      for (const reason of r.reasons) for (const id of reason.evidenceIds) if (!id.startsWith("fetch:")) ids.add(id);
      const obsId = r.freshness.observation.newestAt ? nwpsObservationId(site.lid, r.freshness.observation.newestAt) : null;
      const fcId = r.freshness.forecast.newestAt ? forecastId(site.lid, r.freshness.forecast.newestAt) : null;
      if (obsId) ids.add(obsId);
      if (fcId) ids.add(fcId);
      for (const id of ids) {
        const [kind] = id.split(":") as [Evidence["kind"]];
        const feed = kind === "forecast" ? "nwps" : kind === "alert" ? "nws-alerts" : kind === "reading" ? "nwps" : undefined;
        add(evidence(kind, id.slice(kind.length + 1), `${site.lid} ${kind} ${id.slice(kind.length + 1)}`, feed));
      }
      const reasons = r.reasons.map((x) => ({ ...x, cite: x.evidenceIds.map((id) => `[e:${id}]`).join("") }));
      const label = `${site.short} (${site.lid})`;
      const summary =
        r.status === "review"
          ? `${asOfPhrase}${label} needs review because ${reasons.map((x) => `${x.text} ${x.cite}`).join("; and because ")}.`
          : r.status === "cannot_assess"
            ? `${asOfPhrase}${label} cannot be assessed because ${reasons.map((x) => `${x.text} ${x.cite}`).join("; and because ")}.`
            : `${asOfPhrase}${label} is OK: no review rule fired${r.categoryPeak === "none" && r.peak ? ` (forecast peak ${r.peak.stageFt} ft stays below the action stage)` : ""}${site.tidal ? "; tidal site" : ""}.`;
      return {
        site: site.lid,
        name: site.name,
        basin: site.basin || null,
        status: r.status,
        needsReview: r.status === "review",
        summary,
        reasons,
        categoryNow: r.categoryNow,
        categoryPeak: r.categoryPeak,
        peak: r.peak,
        lowWater: r.lowWater,
        stageFt: r.stageFt,
        stageObservedAt: r.observedAt ?? r.freshness.observation.newestAt,
        change24hFt: r.change24hFt,
        forecastIssuedAt: r.freshness.forecast.newestAt,
        forecastProvenance: r.reasons.find((x) => x.source.startsWith("nwps forecast"))?.source.replace(/^nwps forecast \((.*)\)$/, "$1") ?? null,
        activeAlerts: r.reasons.filter((x) => x.rule === "active_alert").length,
        feeds: {
          usgs: feedAge("usgs"),
          nwps: { state: r.freshness.observation.state, newestAt: r.freshness.observation.newestAt, ageHours: r.freshness.observation.ageHours, cite: obsId ? `[e:${obsId}]` : feedCite("nwps") },
          nwpsForecast: { state: r.freshness.forecast.state, newestAt: r.freshness.forecast.newestAt, ageHours: r.freshness.forecast.ageHours, cite: fcId ? `[e:${fcId}]` : feedCite("nwps") },
          nws: { ...feedAge("nws-alerts"), ...(feedRow("nws-alerts") ? { lastCheckAt: feedRow("nws-alerts")!.lastFetchAt } : {}) },
        },
        thresholds: null,
        siteNote: site.note || null,
        evidenceIds: [...ids],
      };
    });
    const feeds = feedsFor(rawFeeds, ["usgs", "nwps", "nws-alerts", "nws-forecast", "iem"], []);
    const flagged = rows.filter((r) => r.needsReview);
    const inputFeeds = ["usgs", "nwps", "nws-alerts"].map((source) => feedRow(source)).filter((f): f is GqlFeedState => f !== null);
    const ageWords = (newest: string | null) => {
      if (!newest) return "no observation stored";
      const h = hoursBetween(asOf, ms(newest));
      const band = h <= RULES.observationFreshH ? "fresh" : h <= RULES.observationStaleH ? "aging" : "stale";
      return `${h} hours old, ${band}`;
    };
    const inputsLine = `Inputs: ${inputFeeds.map((f) => `${f.source} ${f.state.toLowerCase()}${f.newestObservedAt ? `, newest ${localTime(ctx.app, f.newestObservedAt)} (${ageWords(f.newestObservedAt)})` : ""}${f.lastFetchRunId ? ` [e:fetch:${f.lastFetchRunId}]` : ""}`).join("; ")}.`;
    // Replay: the live state of the same sites, so the answer can say what became known since then.
    let sinceThen: { line: string; rows: { site: string; statusThen: string; statusNow: string; changed: boolean }[] } | null = null;
    if (replaying) {
      const live = await reviewsAt(sites, ctx.now.getTime(), ctx);
      const liveRows = live.reviews.map((now) => {
        const then = reviews.find((r) => r.site === now.site);
        const site = sites.find((s) => s.lid === now.site)!;
        return { site: site.lid, name: site.short, statusThen: then?.status ?? "unknown", statusNow: now.status, changed: (then?.status ?? "unknown") !== now.status, reasonsNow: now.reasons.map((x) => `${x.rule} ${x.evidenceIds.map((id) => `[e:${id}]`).join("")}`) };
      });
      const changed = liveRows.filter((r) => r.changed);
      sinceThen = {
        line: `Since then (as of ${localTime(ctx.app, ctx.now)}): ${changed.length ? changed.map((r) => `${r.name} went from ${r.statusThen.replace("_", " ")} to ${r.statusNow.replace("_", " ")} (${r.reasonsNow.join(", ") || "no rule fires"})`).join("; ") : "no site changed status"}; ${liveRows.filter((r) => r.statusNow === "review").map((r) => r.name).join(", ") || "no site"} need${liveRows.filter((r) => r.statusNow === "review").length === 1 ? "s" : ""} review now.`,
        rows: liveRows,
      };
    }
    const table: TableView = {
      view: "table",
      title: `Needs review · as of ${localTime(ctx.app, asOf)}`,
      columns: [
        { key: "site", label: "Site", kind: "text" },
        { key: "status", label: "Status", kind: "quality" },
        { key: "reasons", label: "Reasons", kind: "text" },
        { key: "category", label: "Category now", kind: "text" },
        { key: "peak", label: "Forecast peak", unit: "ft", kind: "number" },
        { key: "peakCategory", label: "Peak category", kind: "text" },
        { key: "obsAge", label: "Obs age", unit: "h", kind: "number" },
        { key: "fcAge", label: "Forecast age", unit: "h", kind: "number" },
      ],
      rows: rows.map((r) => ({
        evidenceId: r.evidenceIds[0] ?? `fetch:${feedRow("nwps")?.lastFetchRunId ?? "none"}`,
        site: `${r.site} ${r.name}`,
        status: r.status,
        reasons: r.reasons.map((x) => x.rule).join(", ") || null,
        category: r.categoryNow,
        peak: r.peak?.stageFt ?? null,
        peakCategory: r.categoryPeak,
        obsAge: r.feeds.nwps.ageHours,
        fcAge: r.feeds.nwpsForecast.ageHours,
      })),
    };
    return withView(
      output(
        {
          asOf: iso(asOf),
          asOfLocal: localTime(ctx.app, asOf),
          engine: engine === "api" ? "review engine (API)" : "review rules mirrored from the API's siteStatusAt",
          counts: { review: flagged.length, ok: rows.filter((r) => r.status === "ok").length, cannotAssess: rows.filter((r) => r.status === "cannot_assess").length, sites: rows.length },
          flagged: flagged.map((r) => r.site),
          rules: "stage_rise (24 h NWPS rise >= 2 ft, 3 ft at tidal Morgan City), forecast_category (forecast peak at or above action/minor/moderate/major), active_alert (NWS product at the site), rapid_change_forecast (>= 1 ft/day in the next 3 days), source_conflict (gauge vs forecast > 1 ft, never blended), stale_input (observation > 6 h or forecast > 36 h), missing_input. Status: review when a condition rule fires; cannot_assess when inputs are missing or stale; ok otherwise. Not a risk, probability, catch or safety score.",
          boundary: ctx.app.copy.boundaryNote ?? null,
          ...(replaying ? { asOfPhrase: `${asOfPhrase.trim()} (open the answer with these words)` } : {}),
          ...(sinceThen ? { sinceThen: { say: "end with this sentence, markers included", ...sinceThen } } : {}),
          inputsLine: `${inputsLine} (paste this line, markers included, as the freshness line of the answer)`,
          say: "Each row's summary is the sentence to use for that site (copy it, markers included).",
          nextStep: "For anything about the coming days (tomorrow, this week, Friday, low water ahead, a category change) call river_forecast for the sites in question next: it holds the issuance, points, peak, thresholds and horizon.",
          rows,
        },
        evidenceRows,
        feeds,
        rows.length,
      ),
      { result: table, highlight: rows.flatMap((r) => r.evidenceIds.slice(0, 1)).slice(0, MAX_HIGHLIGHT), bbox: sitesBox(sites) },
    );
  },
};

// ---------------------------------------------------------------- review_history

const reviewHistoryInput = z.object({
  site: z.string().min(2).max(80).describe("One site: NWPS id, town or name."),
  from: timeSchema.optional(),
  to: timeSchema.optional().describe("Default: the last 7 days up to the reference time."),
});

const REVIEW_HISTORY_QUERY = `query AgentReviewHistory($site: ID!, $from: Time, $to: Time) {
  reviewHistory(site: $site, from: $from, to: $to) { site from to transitions { at from to rules { rule value threshold source observedAt issuedAt evidenceIds link text } } }
  feeds { ...FeedFields }
}
`;

const HISTORY_STEP_H = 3;

function statusSeriesQuery(n: number): string {
  const vars = [...Array(n).keys()].map((i) => `$t${i}: Time!`).join(", ");
  const fields = [...Array(n).keys()].map((i) => `h${i}: siteStatusAt(site: $site, asOf: $t${i}, conflictFt: $conflictFt) { ${SITE_STATUS_FIELDS} }`).join("\n  ");
  return `query AgentSiteStatusSeries($site: ID!, $conflictFt: Float, ${vars}) {\n  ${fields}\n  feeds { ...FeedFields }\n}\n`;
}

export const reviewHistory = {
  name: "review_history",
  description:
    "Transitions of one site's review status over a window (default the last 7 days): when it entered or left review and which rule and evidence caused it. Use it for why or when a site entered or left review. Cite the evidence ids in each transition's rules.",
  inputSchema: reviewHistoryInput,
  async execute(input: z.infer<typeof reviewHistoryInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const site = resolveSites(ctx.app, [given(input.site) ?? ctx.view?.site ?? input.site])[0]!;
    const to = givenTime(input.to) ? ms(givenTime(input.to)!) : ctx.now.getTime();
    const from = givenTime(input.from) ? ms(givenTime(input.from)!) : to - 7 * 24 * HOUR_MS;
    if (from >= to) throw new Error("time window is empty: from must be before to");
    let flips: { at: string; from: string; to: string; rules: Reason[] }[] = [];
    let rawFeeds: GqlFeedState[] = [];
    let engine: "api" | "mirror" = "api";
    let resolutionHours: number | null = null;
    try {
      const data = await gqlWithFeeds<{ reviewHistory: { transitions: { at: string; from: string; to: string; rules: (Partial<Reason> & { link?: string | null })[] }[] }; feeds: GqlFeedState[] }>("AgentReviewHistory", REVIEW_HISTORY_QUERY, { site: site.lid, from: iso(from), to: iso(to) }, ctx);
      flips = data.reviewHistory.transitions.map((t) => ({ at: t.at, from: t.from, to: t.to, rules: t.rules.map((x) => ({ rule: x.rule as Reason["rule"], value: x.value ?? null, threshold: x.threshold ?? null, source: x.source ?? "", observedAt: x.observedAt, issuedAt: x.issuedAt, evidenceIds: x.evidenceIds ?? (x.link ? [x.link] : []), text: x.text ?? "" })) }));
      rawFeeds = data.feeds;
    } catch (error) {
      if (!isMissingField(error)) throw error;
      engine = "mirror";
      resolutionHours = HISTORY_STEP_H;
      const times: number[] = [];
      for (let t = from; t <= to; t += HISTORY_STEP_H * HOUR_MS) times.push(t);
      if (times[times.length - 1] !== to) times.push(to);
      const vars = Object.fromEntries(times.map((t, i) => [`t${i}`, iso(t)]));
      const data = await gqlWithFeeds<Record<string, GqlSiteStatus> & { feeds: GqlFeedState[] }>("AgentSiteStatusSeries", statusSeriesQuery(times.length), { site: site.lid, conflictFt: RULES.conflictFt, ...vars }, ctx);
      rawFeeds = data.feeds;
      const fetchId = (source: string) => data.feeds.find((f) => f.source === source)?.lastFetchRunId ?? null;
      const feedEvidence = { usgs: fetchId("usgs") ? `fetch:${fetchId("usgs")}` : null, nwps: fetchId("nwps") ? `fetch:${fetchId("nwps")}` : null, nws: fetchId("nws-alerts") ? `fetch:${fetchId("nws-alerts")}` : null };
      const samples = times.map((t, i) => {
        const dayAgoIndex = times.findIndex((u) => Math.abs(u - (t - 24 * HOUR_MS)) < HOUR_MS);
        return reviewFromStatus(site, data[`h${i}`]!, dayAgoIndex >= 0 ? data[`h${dayAgoIndex}`]! : null, t, feedEvidence);
      });
      flips = transitions(samples);
    }
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    for (const flip of flips) {
      for (const rule of flip.rules) {
        for (const id of rule.evidenceIds) {
          if (seen.has(id) || id.startsWith("fetch:")) continue;
          seen.add(id);
          const [kind] = id.split(":") as [Evidence["kind"]];
          evidenceRows.push(evidence(kind, id.slice(kind.length + 1), `${site.lid} ${kind} ${id.slice(kind.length + 1)}`, kind === "alert" ? "nws-alerts" : "nwps"));
        }
      }
    }
    const rows = flips.map((f) => ({
      at: f.at,
      atLocal: localTime(ctx.app, f.at),
      ...(resolutionHours ? { atIsSampleTime: `status sampled every ${resolutionHours} h; the cause's own time is in the rule (issuedAt or observedAt)` } : {}),
      from: f.from,
      to: f.to,
      rules: f.rules.map((x) => ({ ...x, cite: x.evidenceIds.map((id) => `[e:${id}]`).join("") })),
    }));
    const table: TableView = {
      view: "table",
      title: `Review history · ${site.short}`,
      columns: [
        { key: "at", label: "When", kind: "time" },
        { key: "from", label: "From", kind: "text" },
        { key: "to", label: "To", kind: "text" },
        { key: "rules", label: "Rules", kind: "text" },
      ],
      rows: rows.map((r) => ({ evidenceId: r.rules[0]?.evidenceIds[0] ?? `forecast:${site.lid}:0`, at: r.at, from: r.from, to: r.to, rules: r.rules.map((x) => x.rule).join(", ") })),
    };
    const feeds = feedsFor(rawFeeds, ["nwps", "nws-alerts"], []);
    return withView(
      output(
        {
          site: site.lid,
          name: site.name,
          window: { from: iso(from), to: iso(to), fromLocal: localTime(ctx.app, from), toLocal: localTime(ctx.app, to) },
          engine: engine === "api" ? "review engine (API)" : `review rules mirrored over siteStatusAt samples every ${HISTORY_STEP_H} h`,
          transitionCount: flips.length,
          note: flips.length === 0 ? "No change of status in the window." : "Each transition lists the rules in force after it; the cause's own time (issuedAt, observedAt) is more exact than the sample time.",
          transitions: rows,
        },
        evidenceRows,
        feeds,
        flips.length,
      ),
      { result: table, highlight: evidenceRows.slice(0, MAX_HIGHLIGHT).map((e) => e.id), bbox: sitesBox([site]) },
    );
  },
};

// ---------------------------------------------------------------- river_readings

const READINGS_QUERY = `query AgentRiverReadings($bbox: BBox!, $from: Time!, $to: Time!, $params: [Param!]) {
  readings(bbox: $bbox, from: $from, to: $to, params: $params) { station { id source name lat lon kind } param value flag observedAt origin }
  feeds { ...FeedFields }
}
`;

type GqlReading = { station: { id: string; source: string; name: string; lat: number; lon: number; kind: string }; param: string; value: number | null; flag: string; observedAt: string; origin: string };

const riverReadingsInput = z.object({
  sites: sitesInput,
  from: timeSchema.optional(),
  to: timeSchema.optional().describe("End of the window (default: the reference time)."),
  hours: z.number().min(1).max(24 * 30).optional().describe("Lookback from `to` (default 24; 72 for three days, 168 for a week)."),
  params: z.array(z.enum(["stage", "discharge"])).optional().describe("Default both."),
  source: z.enum(["usgs", "nwps", "both"]).optional().describe("Default both: USGS 15-minute series and the newest NWPS observation."),
});

/** One USGS station's readings for a site: the gauge whose station id or name carries the USGS site number. */
function usgsRows(all: readonly GqlReading[], site: SiteRef): GqlReading[] {
  if (!site.usgs) return [];
  return all.filter((r) => r.station.source === "usgs" && (r.station.id === site.usgs || r.station.name.includes(site.usgs!) || (Math.abs(r.station.lat - site.lat) < 0.03 && Math.abs(r.station.lon - site.lon) < 0.03)));
}

function summarize(series: readonly GqlReading[], toFt: boolean) {
  const usable = series.filter((r) => r.value !== null && r.flag.toLowerCase() === "ok").sort((a, b) => ms(a.observedAt) - ms(b.observedAt));
  if (usable.length === 0) return null;
  const conv = (v: number) => (toFt ? r2(v * FT_PER_M) : v);
  const values = usable.map((r) => conv(r.value!));
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const target = ms(last.observedAt) - 24 * HOUR_MS;
  const dayAgo = usable.filter((r) => Math.abs(ms(r.observedAt) - target) <= 90 * 60_000).sort((a, b) => Math.abs(ms(a.observedAt) - target) - Math.abs(ms(b.observedAt) - target))[0] ?? null;
  const lastDay = usable.filter((r) => ms(r.observedAt) >= ms(last.observedAt) - 24 * HOUR_MS);
  return {
    latest: { value: conv(last.value!), at: last.observedAt, evidenceId: `reading:${readingKey(last.station.id, last.param, last.observedAt, last.origin)}` },
    first: { value: conv(first.value!), at: first.observedAt, evidenceId: `reading:${readingKey(first.station.id, first.param, first.observedAt, first.origin)}` },
    netChange: r2(conv(last.value!) - conv(first.value!)),
    change24h: dayAgo ? { value: r2(conv(last.value!) - conv(dayAgo.value!)), from: dayAgo.observedAt, evidenceId: `reading:${readingKey(dayAgo.station.id, dayAgo.param, dayAgo.observedAt, dayAgo.origin)}` } : null,
    min: Math.min(...values),
    max: Math.max(...values),
    mean24h: lastDay.length ? r2(lastDay.reduce((s, r) => s + conv(r.value!), 0) / lastDay.length) : null,
    samples: usable.length,
    rows: usable,
  };
}

export const riverReadings = {
  name: "river_readings",
  description:
    "Observed stage and discharge per site: the USGS 15-minute series (stage ft on the USGS gauge datum, with the stored metres; discharge cfs) with latest, first, net change, 24 h change, min, max and the 24 h mean (use the mean at tidal Morgan City), plus the newest NWPS observation (stage ft on the NWPS datum, flow kcfs where NWPS reports it). Every value is labelled with its source and unit; USGS and NWPS flow are never blended. notMeasured marks a parameter the gauge does not report; datumNote marks sites where the two stages sit on different datums (Krotz Springs). Cite reading ids.",
  inputSchema: riverReadingsInput,
  async execute(input: z.infer<typeof riverReadingsInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const sites = resolveSites(ctx.app, givenList(input.sites));
    const window = lookbackWindow(input, ctx.now, 24, 24 * 30);
    const to = ms(window.to);
    const from = ms(window.from);
    const hours = input.hours ?? 24;
    const params = input.params ?? ["stage", "discharge"];
    const source = input.source ?? "both";
    const gqlParams = params.map((p) => (p === "stage" ? "STAGE_M" : "DISCHARGE_CFS"));
    const query = `${READINGS_QUERY.replace("feeds { ...FeedFields }", `${source === "usgs" ? "" : [...Array(sites.length).keys()].map((i) => `s${i}: siteStatusAt(site: $s${i}, asOf: $to) { site asOf observation { observedAt ingestedAt source stageFt flowKcfs } thresholds { actionFt minorFt moderateFt majorFt } category }`).join("\n  ")}\n  feeds { ...FeedFields }`)}`;
    const withSites = source === "usgs" ? query : query.replace("query AgentRiverReadings(", `query AgentRiverReadings(${[...Array(sites.length).keys()].map((i) => `$s${i}: ID!, `).join("")}`);
    const data = await gqlWithFeeds<Record<string, unknown> & { readings: GqlReading[]; feeds: GqlFeedState[] }>("AgentRiverReadings", withSites, { bbox: appBBox(ctx.app), from: iso(from), to: iso(to), params: gqlParams, ...(source === "usgs" ? {} : siteVars(sites)) }, ctx);
    // A window shorter than a day can miss a gauge that stopped reporting hours ago. When a USGS series is empty
    // in such a window, the newest reading of the last 7 days is reported with its age instead of "no series": a
    // stopped gauge is a late one, not an unmeasured parameter.
    const WIDER_HOURS = 24 * 7;
    let wider: GqlReading[] = [];
    if (source !== "nwps" && to - from < 24 * HOUR_MS && sites.some((site) => params.some((param) => !usgsRows(data.readings, site).some((r) => r.param.toLowerCase() === (param === "stage" ? "stage_m" : "discharge_cfs"))))) {
      const back = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>("AgentRiverReadings", READINGS_QUERY, { bbox: appBBox(ctx.app), from: iso(to - WIDER_HOURS * HOUR_MS), to: iso(to), params: gqlParams }, ctx);
      wider = back.readings;
    }
    const evidenceRows: Evidence[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string, feed: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const [kind] = id.split(":") as [Evidence["kind"]];
      evidenceRows.push(evidence(kind, id.slice(kind.length + 1), label, feed));
    };
    const viewRows: ReadingRow[] = [];
    const latestRows: ReadingRow[] = [];
    const rows = sites.flatMap((site, i) => {
      const out: Record<string, unknown>[] = [];
      const usgs = usgsRows(data.readings, site);
      const status = source === "usgs" ? null : (data[`s${i}`] as Pick<GqlSiteStatus, "observation" | "thresholds" | "category"> | undefined) ?? null;
      const datumNote = /datum/i.test(site.note) ? site.note : null;
      if (source !== "nwps") {
        for (const param of params) {
          const gqlParam = param === "stage" ? "stage_m" : "discharge_cfs";
          const series = usgs.filter((r) => r.param.toLowerCase() === gqlParam);
          const summary = summarize(series, param === "stage");
          if (!summary) {
            const earlier = series.length === 0 ? summarize(usgsRows(wider, site).filter((r) => r.param.toLowerCase() === gqlParam), param === "stage") : null;
            if (earlier) {
              const unit = param === "stage" ? "ft" : "cfs";
              add(earlier.latest.evidenceId, `USGS ${site.usgs} ${param} ${earlier.latest.value} ${unit} · ${earlier.latest.at}`, "usgs");
              out.push({ site: site.lid, name: site.name, source: "usgs", station: site.usgs, param, unit, notMeasured: false, latest: earlier.latest, ageHours: hoursBetween(to, ms(earlier.latest.at)), note: `no USGS ${param} reading in the asked window (${window.from} to ${window.to}); the newest known reading is ${earlier.latest.value} ${unit} at ${earlier.latest.at}, ${hoursBetween(to, ms(earlier.latest.at))} hours old: the gauge stopped reporting, say so with the age` });
              continue;
            }
            out.push({ site: site.lid, name: site.name, source: "usgs", station: site.usgs, param, unit: param === "stage" ? "ft" : "cfs", notMeasured: series.length === 0, latest: null, note: series.length === 0 ? `USGS gauge ${site.usgs} reports no ${param} series${param === "discharge" ? " (stage only; NWPS flow, where present, is an NWS estimate in kcfs, not a USGS measurement)" : ""}` : `no usable ${param} value in the window` });
            continue;
          }
          add(summary.latest.evidenceId, `USGS ${site.usgs} ${param} ${summary.latest.value} ${param === "stage" ? "ft" : "cfs"} · ${summary.latest.at}`, "usgs");
          add(summary.first.evidenceId, `USGS ${site.usgs} ${param} ${summary.first.value} ${param === "stage" ? "ft" : "cfs"} · ${summary.first.at}`, "usgs");
          if (summary.change24h) add(summary.change24h.evidenceId, `USGS ${site.usgs} ${param} at ${summary.change24h.from}`, "usgs");
          const unit = param === "stage" ? "ft" : "cfs";
          const viewParam = param === "stage" ? "stage_ft" : "discharge_cfs";
          const toRow = (r: GqlReading): ReadingRow => ({ evidenceId: `reading:${readingKey(r.station.id, r.param, r.observedAt, r.origin)}`, stationId: r.station.id, station: `${site.short} (USGS)`, source: "usgs", lat: r.station.lat, lon: r.station.lon, param: viewParam, value: r.value === null ? null : param === "stage" ? r2(r.value * FT_PER_M) : r.value, flag: r.flag.toLowerCase(), origin: "measured", observedAt: r.observedAt });
          viewRows.push(...summary.rows.map(toRow));
          latestRows.push(toRow(summary.rows[summary.rows.length - 1]!));
          out.push({
            site: site.lid,
            name: site.name,
            source: "usgs",
            station: site.usgs,
            param,
            unit,
            ...(param === "stage" ? { datum: datumNote ? "USGS gauge datum (differs from NWPS here)" : "USGS gauge datum", storedAs: "stage_m (metres), shown in ft" } : {}),
            latest: { value: summary.latest.value, ...(param === "stage" ? { metres: r2(summary.latest.value / FT_PER_M) } : { kcfs: r2(summary.latest.value / 1000) }), at: summary.latest.at, atLocal: localTime(ctx.app, summary.latest.at), ageHours: hoursBetween(to, ms(summary.latest.at)), cite: `[e:${summary.latest.evidenceId}]` },
            windowStart: { value: summary.first.value, at: summary.first.at, cite: `[e:${summary.first.evidenceId}]` },
            netChangeInWindow: summary.netChange,
            change24h: summary.change24h ? { value: summary.change24h.value, since: summary.change24h.from, cite: `[e:${summary.change24h.evidenceId}]` } : null,
            min: summary.min,
            max: summary.max,
            ...(site.tidal || param === "discharge" ? { mean24h: summary.mean24h } : {}),
            samples: summary.samples,
            ...(datumNote && param === "stage" ? { datumNote: `${datumNote} Never compare this USGS stage with the NWPS flood thresholds.` } : {}),
            ...(site.tidal ? { tidalNote: `Tidal site: instantaneous values swing with the tide; compare the 24 h mean (${summary.mean24h} ${unit} over the last 24 hours) and say 'mean', not single readings.` } : {}),
          });
        }
      }
      if (status) {
        const obs = status.observation;
        if (obs) {
          const id = nwpsObservationId(site.lid, obs.observedAt);
          add(id, `NWPS ${site.lid} stage ${obs.stageFt ?? "missing"} ft · ${obs.observedAt}`, "nwps");
          const th = thresholdsOf(status.thresholds);
          out.push({
            site: site.lid,
            name: site.name,
            source: "nwps",
            station: site.lid,
            param: "stage",
            unit: "ft",
            datum: "NWPS gauge datum (the datum the flood categories use)",
            latest: { value: obs.stageFt, at: obs.observedAt, atLocal: localTime(ctx.app, obs.observedAt), ageHours: hoursBetween(to, ms(obs.observedAt)), cite: `[e:${id}]` },
            category: lowerCat(status.category) ?? categoryOf(obs.stageFt, th),
            thresholdsFt: th,
            ...(obs.flowKcfs !== null ? { flow: { value: obs.flowKcfs, unit: "kcfs", cfs: Math.round(obs.flowKcfs * 1000), source: "nwps (NWS estimate, often a rating-curve conversion)", cite: `[e:${id}]` } } : { flow: { notMeasured: true, note: "NWPS reports no flow at this gauge" } }),
            ...(datumNote ? { datumNote } : {}),
            ...(/disagree|5 to 7/i.test(site.note) ? { flowNote: site.note } : {}),
          });
          latestRows.push({ evidenceId: id, stationId: site.lid, station: `${site.short} (NWPS)`, source: "nwps", lat: site.lat, lon: site.lon, param: "stage_ft", value: obs.stageFt, flag: "ok", origin: "measured", observedAt: obs.observedAt });
          if (obs.flowKcfs !== null) latestRows.push({ evidenceId: id, stationId: site.lid, station: `${site.short} (NWPS)`, source: "nwps", lat: site.lat, lon: site.lon, param: "flow_kcfs", value: obs.flowKcfs, flag: "ok", origin: "measured", observedAt: obs.observedAt });
        } else {
          out.push({ site: site.lid, name: site.name, source: "nwps", station: site.lid, param: "stage", unit: "ft", latest: null, notMeasured: false, note: `no NWPS observation known at ${iso(to)}` });
        }
      }
      return out;
    });
    const feeds = feedsFor(data.feeds, source === "both" ? ["usgs", "nwps"] : [source], []);
    const view = conditionsViews(viewRows, latestRows, sitesBox(sites), ["stage_ft", "discharge_cfs", "flow_kcfs"], `${sites.length === 1 ? sites[0]!.short : `${sites.length} sites`} · last ${r1(hours)} h`);
    return withView(
      output(
        {
          window: { from: iso(from), to: iso(to), hours: r1((to - from) / HOUR_MS), label: `last ${r1((to - from) / HOUR_MS) === 24 ? "24 hours" : r1((to - from) / HOUR_MS) % 24 === 0 ? `${(to - from) / (24 * HOUR_MS)} days` : `${r1((to - from) / HOUR_MS)} hours`}`, toLocal: localTime(ctx.app, to), say: "name the window as its label ('last 24 hours', 'last 7 days')" },
          units: "stage ft (USGS stored as stage_m metres, converted; NWPS native ft), discharge cfs (USGS), flow kcfs (NWPS, 1 kcfs = 1000 cfs). Label every number with its source. Flood categories use NWPS stage only.",
          ...(sites.some((s) => s.tidal) ? { tidalSites: `${sites.filter((s) => s.tidal).map((s) => `${s.lid} ${s.short}`).join(", ")}: tidal, so instantaneous stage and discharge swing with the tide; answer with the 24 h mean (mean24h) and say 'tidal' and 'mean'` } : {}),
          rows,
        },
        evidenceRows,
        feeds,
        rows.length,
      ),
      view,
    );
  },
};

// ---------------------------------------------------------------- forecast_verify

const VERIFY_QUERY = `query AgentForecastVerify($site: ID!, $issuedAt: Time!) {
  forecastVerify(site: $site, issuedAt: $issuedAt) {
    site issuedAt snapshot { ${SNAPSHOT_FIELDS} }
    points { validAt forecastFt forecastCategory observedAt observedFt observedCategory errorFt missing }
    paired missing biasFt meanAbsErrorFt maxAbsErrorFt peakForecastFt peakForecastCategory peakObservedFt peakObservedCategory peakCategoryHit
  }
  feeds { ...FeedFields }
}
`;

type GqlVerify = {
  site: string;
  issuedAt: string;
  snapshot: GqlSnapshot;
  points: { validAt: string; forecastFt: number | null; forecastCategory: string | null; observedAt: string | null; observedFt: number | null; observedCategory: string | null; errorFt: number | null; missing: boolean }[];
  paired: number;
  missing: number;
  biasFt: number | null;
  meanAbsErrorFt: number | null;
  maxAbsErrorFt: number | null;
  peakForecastFt: number | null;
  peakForecastCategory: string | null;
  peakObservedFt: number | null;
  peakObservedCategory: string | null;
  peakCategoryHit: boolean | null;
};

const forecastVerifyInput = z.object({
  sites: sitesInput,
  issuedAt: timeSchema.optional().describe("Exact issuance time to score (from river_forecast)."),
  daysAgo: z.number().min(0.5).max(30).optional().describe("Score the issuance that was current this many days before the reference time (default 2)."),
});

export const forecastVerify = {
  name: "forecast_verify",
  description:
    "Score a past NWPS issuance against the NWPS observed stage at its valid times: paired points with the error per point (forecast minus observed, ft), bias, mean absolute error, largest miss, the peak comparison, and how many valid times have not happened yet (pending). Pick the issuance by exact issuedAt or by daysAgo (the one that was current then). Cite the issuance's forecast id and the observations' reading ids.",
  inputSchema: forecastVerifyInput,
  async execute(input: z.infer<typeof forecastVerifyInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const sites = resolveSites(ctx.app, givenList(input.sites));
    const now = ctx.now.getTime();
    const daysAgo = input.daysAgo ?? 2;
    const asOf = now - daysAgo * 24 * HOUR_MS;
    let issuedBySite: Record<string, string | null> = {};
    let rawFeeds: GqlFeedState[] = [];
    const issuedAtText = givenTime(input.issuedAt);
    // The issuance to score: the one made at `issuedAt` when there is one, else the one current at that time
    // (a model often passes a knowledge time here), else the one current `daysAgo` days ago.
    const lookupAt = issuedAtText ? ms(issuedAtText) + HOUR_MS : asOf;
    const data = await gqlWithFeeds<Record<string, GqlForecastView> & { feeds: GqlFeedState[] }>("AgentForecasts", forecastsQuery(sites.length), { ...siteVars(sites), asOf: iso(lookupAt), history: issuedAtText ? 10 : 1 }, ctx);
    rawFeeds = data.feeds;
    issuedBySite = Object.fromEntries(
      sites.map((s, i) => {
        const view = data[`f${i}`];
        if (!view) return [s.lid, null];
        if (!issuedAtText) return [s.lid, view.snapshot?.issuedAt ?? null];
        const wanted = ms(issuedAtText);
        const exact = view.history.find((snap) => Math.abs(ms(snap.issuedAt) - wanted) <= 60_000);
        const current = view.history.find((snap) => ms(snap.issuedAt) <= wanted) ?? view.snapshot;
        return [s.lid, exact?.issuedAt ?? current?.issuedAt ?? null];
      }),
    );
    const evidenceRows: Evidence[] = [];
    const series: SeriesView[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const site of sites) {
      const issuedAt = issuedBySite[site.lid];
      if (!issuedAt) {
        rows.push({ site: site.lid, name: site.name, missing: `no forecast was known for ${site.lid} at ${iso(asOf)}` });
        continue;
      }
      let v: GqlVerify;
      try {
        const data = await gqlWithFeeds<{ forecastVerify: GqlVerify; feeds: GqlFeedState[] }>("AgentForecastVerify", VERIFY_QUERY, { site: site.lid, issuedAt }, ctx);
        v = data.forecastVerify;
        rawFeeds = data.feeds;
      } catch (error) {
        rows.push({ site: site.lid, name: site.name, issuedAt, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const fid = forecastId(site.lid, v.issuedAt);
      evidenceRows.push(evidence("forecast", fid.slice("forecast:".length), `${site.lid} forecast issued ${v.issuedAt} (${provenance(v.snapshot.source)})`, feedOf(v.snapshot.source)));
      const pairs = v.points
        .filter((p) => !p.missing && p.observedAt)
        .map((p) => {
          const id = nwpsObservationId(site.lid, p.observedAt!);
          evidenceRows.push(evidence("reading", id.slice("reading:".length), `NWPS ${site.lid} stage ${p.observedFt} ft · ${p.observedAt}`, "nwps"));
          return { at: p.validAt, atLocal: localTime(ctx.app, p.validAt), forecastFt: p.forecastFt, observedFt: p.observedFt, observedAt: p.observedAt, errorFt: p.errorFt, cite: `[e:${id}]` };
        });
      const pending = v.points.filter((p) => p.missing && ms(p.validAt) > now).length;
      const unpaired = v.points.filter((p) => p.missing && ms(p.validAt) <= now).length;
      series.push({
        view: "series",
        title: `Forecast vs observed · ${site.short} · issued ${localTime(ctx.app, v.issuedAt)}`,
        unit: "ft",
        series: [
          { label: `forecast (${provenance(v.snapshot.source)})`, evidenceId: fid, points: v.points.map((p) => [ms(p.validAt), p.forecastFt] as [number, number | null]) },
          { label: "observed (NWPS)", points: v.points.map((p) => [ms(p.validAt), p.observedFt] as [number, number | null]) },
        ],
      });
      rows.push({
        site: site.lid,
        name: site.name,
        issuedAt: v.issuedAt,
        issuedLocal: localTime(ctx.app, v.issuedAt),
        issuance: `forecast issued ${localTime(ctx.app, v.issuedAt)} (${provenance(v.snapshot.source)}) [e:${fid}]`,
        headline: `${site.lid}: forecast issued ${localTime(ctx.app, v.issuedAt)} (${provenance(v.snapshot.source)}) scored against ${v.paired} observed NWPS readings: mean absolute error ${v.meanAbsErrorFt ?? "n/a"} ft, largest miss ${v.maxAbsErrorFt ?? "n/a"} ft [e:${fid}]`,
        provenance: provenance(v.snapshot.source),
        cite: `[e:${fid}]`,
        pairs: pairs.slice(0, 16),
        quote: pairs[pairs.length - 1] ? `forecast ${pairs[pairs.length - 1]!.forecastFt} ft vs observed ${pairs[pairs.length - 1]!.observedFt} ft at ${pairs[pairs.length - 1]!.atLocal} ${pairs[pairs.length - 1]!.cite} (say this pair, with the word 'observed')` : null,
        paired: v.paired,
        pending,
        unpairedPast: unpaired,
        biasFt: v.biasFt,
        meanAbsErrorFt: v.meanAbsErrorFt,
        maxErrorFt: v.maxAbsErrorFt,
        peak: { forecastFt: v.peakForecastFt, forecastCategory: lowerCat(v.peakForecastCategory), observedSoFarFt: v.peakObservedFt, observedCategory: lowerCat(v.peakObservedCategory), categoryHit: v.peakCategoryHit },
        note: "error = forecast minus observed (positive: the forecast ran high). Observations are NWPS stage on the NWPS datum; pending points have not happened yet.",
      });
    }
    const feeds = feedsFor(rawFeeds, ["nwps", "iem"], []);
    const [first, ...rest] = series;
    const view: ToolViewData = first ? { result: first, more: rest, highlight: evidenceRows.slice(0, MAX_HIGHLIGHT).map((e) => e.id), bbox: sitesBox(sites) } : { result: rowsTable("Forecast verification", rows), bbox: sitesBox(sites) };
    return withView(output({ asOfForIssuance: issuedAtText ? null : iso(asOf), say: "Start each site with its `headline`, copied verbatim, then its `quote` pair (forecast vs observed).", rows }, evidenceRows, feeds, rows.filter((r) => !("missing" in r || "error" in r)).length), view);
  },
};

// ---------------------------------------------------------------- weather_forecast

const WEATHER_QUERY = `query AgentWeatherForecast($bbox: BBox!, $from: Time!, $to: Time!, $params: [Param!]) {
  readings(bbox: $bbox, from: $from, to: $to, params: $params) { station { id source name lat lon kind } param value flag observedAt origin }
  feeds { ...FeedFields }
}
`;

const weatherInput = z
  .object({
    site: z.string().min(2).max(80).optional().describe("A configured location: NWPS id, town or name."),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    periods: z.number().int().min(1).max(14).optional().describe("Forecast periods (12 h each) from the reference time (default 6 = 3 days)."),
  })
  .refine((v) => v.site !== undefined || (v.lat !== undefined && v.lon !== undefined), "give site, or lat and lon");

const C_TO_F = (c: number) => r1((c * 9) / 5 + 32);
const MS_TO_MPH = (v: number) => r1(v / 0.44704);
const MM_TO_IN = (mm: number) => r2(mm / 25.4);
const WEATHER_PARAMS = ["AIR_C", "WIND_MS", "POP_PCT", "RAIN_MM", "WIND_GUST_MS"];
/** The raw grid's native QPF window (api/src/ingest/poll/nws_forecast.rs): a lone last window ends 6 h after it starts. */
const QPF_WINDOW_MS = 6 * HOUR_MS;

/** Precipitation of a 12 h period from the grid's 6 h QPF windows and hourly gusts stored as readings. */
export function periodPrecip(
  rain: readonly { t: number; v: number | null }[],
  gusts: readonly { t: number; v: number | null }[],
  start: number,
  end: number,
): { qpfMm: number | null; windows: number; gustMs: number | null } {
  // A window belongs to the period its start falls in; windows run to the next window's start (NWS windows
  // are contiguous), so a period and its windows never double count.
  let qpf: number | null = null;
  let windows = 0;
  for (const [i, w] of rain.entries()) {
    const wEnd = rain[i + 1]?.t ?? w.t + QPF_WINDOW_MS;
    if (w.t < start || w.t >= end || wEnd <= start) continue;
    windows += 1;
    if (w.v !== null) qpf = (qpf ?? 0) + w.v;
  }
  let gust: number | null = null;
  for (const g of gusts) if (g.t >= start && g.t < end && g.v !== null && (gust === null || g.v > gust)) gust = g.v;
  return { qpfMm: qpf === null ? null : r2(qpf), windows, gustMs: gust };
}

export const weatherForecast = {
  name: "weather_forecast",
  description:
    "NWS gridpoint forecast periods (12 h) for a site or point from api.weather.gov, as the gridpoint adapter stores them: per period the air temperature (°F and °C), wind (mph and m/s, the period's upper bound), the highest gust, the chance of precipitation (percent, NWS's own period value) and the forecast precipitation amount (QPF, in and mm, summed from the grid's 6 h windows starting in the period), with the office and grid, when the office updated the run and when we fetched it. A rain forecast is weather, not a flood or stage prediction. Cite the forecast:nws id.",
  inputSchema: weatherInput,
  async execute(input: z.infer<typeof weatherInput>, ctx: CapabilityContext): Promise<CapabilityOutput> {
    const siteName = given(input.site);
    // A species app has no configured locations: a `site` there is a place name, so the point comes from lat and lon.
    const site = siteName && ctx.app.locations.length > 0 ? resolveSites(ctx.app, [siteName])[0]! : null;
    if (!site && (input.lat === undefined || input.lon === undefined)) throw new Error(ctx.app.locations.length > 0 ? "give a configured site (NWPS id, town or name), or lat and lon" : "give lat and lon (from geocode) for the place");
    const lat = site?.lat ?? input.lat!;
    const lon = site?.lon ?? input.lon!;
    const periods = input.periods ?? 6;
    const now = ctx.now.getTime();
    const from = now - 12 * HOUR_MS;
    const to = now + periods * 12 * HOUR_MS;
    // The point's own grid cell, else the nearest gridpoint within half a degree (a park has one grid per office).
    const bbox: BBox = { west: lon - 0.06, south: lat - 0.06, east: lon + 0.06, north: lat + 0.06 };
    const isGrid = (r: GqlReading) => r.origin.toLowerCase() === "modeled" && (r.station.kind.toLowerCase() === "grid" || r.station.source === "nws-forecast" || r.station.source === "nws");
    let data = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>("AgentWeatherForecast", WEATHER_QUERY, { bbox, from: iso(from), to: iso(to), params: WEATHER_PARAMS }, ctx);
    let nearest: string | null = null;
    if (!data.readings.some(isGrid) && !site) {
      const wide: BBox = { west: lon - 0.5, south: lat - 0.5, east: lon + 0.5, north: lat + 0.5 };
      const around = await gqlWithFeeds<{ readings: GqlReading[]; feeds: GqlFeedState[] }>("AgentWeatherForecast", WEATHER_QUERY, { bbox: wide, from: iso(from), to: iso(to), params: WEATHER_PARAMS }, ctx);
      const grids = around.readings.filter(isGrid);
      const best = grids.map((r) => r.station).sort((a, b) => Math.hypot(a.lat - lat, a.lon - lon) - Math.hypot(b.lat - lat, b.lon - lon))[0];
      if (best) {
        nearest = best.name;
        data = { readings: grids.filter((r) => r.station.id === best.id), feeds: around.feeds };
      }
    }
    const modeled = data.readings.filter(isGrid);
    // Period rows are keyed by the 12 h period start (air, wind, PoP); QPF windows and gusts have their own times.
    const byTime = new Map<string, Partial<Record<string, number | null>>>();
    const series = (param: string) =>
      modeled
        .filter((r) => r.param === param)
        .map((r) => ({ t: ms(r.observedAt), v: r.value }))
        .sort((a, b) => a.t - b.t);
    const rain = series("RAIN_MM");
    const gusts = series("WIND_GUST_MS");
    for (const r of modeled) {
      if (r.param === "RAIN_MM" || r.param === "WIND_GUST_MS") continue;
      const slot = byTime.get(r.observedAt) ?? {};
      slot[r.param.toLowerCase()] = r.value;
      byTime.set(r.observedAt, slot);
    }
    const feed = data.feeds.find((f) => f.source === "nws-forecast") ?? data.feeds.find((f) => f.source === "nws") ?? null;
    const updateTime = feed?.newestObservedAt ?? feed?.lastFetchAt ?? null;
    const gridStation = modeled[0]?.station ?? null;
    const office = site?.office ?? gridStation?.name.match(/\b([A-Z]{3})\b/)?.[1] ?? "NWS";
    const grid = site?.grid ?? (gridStation ? gridStation.id : `${lat.toFixed(3)},${lon.toFixed(3)}`);
    // No comma in an id: the citation parser splits marker groups on commas.
    const fid = `nws:${office}/${grid.replace(",", "x")}:${updateTime ? ms(updateTime) : 0}`;
    const rows = [...byTime.entries()]
      .sort((a, b) => ms(a[0]) - ms(b[0]))
      .filter(([at]) => ms(at) >= now - 12 * HOUR_MS)
      .slice(0, periods)
      .map(([at, slot]) => {
        const c = slot.air_c ?? null;
        const w = slot.wind_ms ?? null;
        const start = ms(at);
        const end = start + 12 * HOUR_MS;
        const precip = periodPrecip(rain, gusts, start, end);
        return {
          start: at,
          startLocal: localTime(ctx.app, at),
          end: iso(end),
          temperatureF: c === null ? null : C_TO_F(c),
          temperatureC: c,
          windMph: w === null ? null : MS_TO_MPH(w),
          windMs: w,
          gustMph: precip.gustMs === null ? null : MS_TO_MPH(precip.gustMs),
          precipChancePct: slot.pop_pct ?? null,
          qpfIn: precip.qpfMm === null ? null : MM_TO_IN(precip.qpfMm),
          qpfMm: precip.qpfMm,
          qpfWindows: precip.windows,
          cite: `[e:forecast:${fid}]`,
        };
      });
    const anyPrecip = rows.some((r) => r.precipChancePct !== null || r.qpfMm !== null);
    const evidenceRows: Evidence[] = rows.length ? [evidence("forecast", fid, `NWS gridpoint forecast ${office} ${grid} updated ${updateTime ?? "unknown"}`, feed?.source ?? "nws-forecast")] : [];
    const feeds = feedsFor(data.feeds, feed ? [feed.source] : [], ["nws"]);
    const seriesView: SeriesView = {
      view: "series",
      title: `NWS forecast · ${site?.short ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`}`,
      unit: "°F",
      series: [{ label: "air temperature", evidenceId: `forecast:${fid}`, points: rows.map((r) => [ms(r.start), r.temperatureF] as [number, number | null]) }],
    };
    const table: TableView = {
      view: "table",
      title: "Forecast periods",
      columns: [
        { key: "start", label: "Period start", kind: "time" },
        { key: "temperatureF", label: "Temp", unit: "°F", kind: "number" },
        { key: "windMph", label: "Wind", unit: "mph", kind: "number" },
        { key: "precipChancePct", label: "Rain chance", unit: "%", kind: "number" },
        { key: "qpfIn", label: "Rain amount", unit: "in", kind: "number" },
      ],
      rows: rows.map((r) => ({ evidenceId: `forecast:${fid}`, start: r.start, temperatureF: r.temperatureF, windMph: r.windMph, precipChancePct: r.precipChancePct, qpfIn: r.qpfIn })),
    };
    return withView(
      output(
        {
          site: site?.lid ?? null,
          name: site?.name ?? gridStation?.name ?? null,
          ...(nearest ? { nearest: `no gridpoint at the point itself; this is the nearest stored gridpoint, ${nearest}` } : {}),
          office,
          grid,
          updateTime,
          updateLocal: updateTime ? localTime(ctx.app, updateTime) : null,
          fetchedAt: feed?.lastFetchAt ?? null,
          ageHours: updateTime ? hoursBetween(now, ms(updateTime)) : null,
          cite: rows.length ? `[e:forecast:${fid}]` : null,
          stored: anyPrecip
            ? "per 12 h period: temperature, wind (upper bound of the range), highest gust, precipChancePct (NWS's chance of precipitation for the period, a probability, not an amount) and qpfIn/qpfMm (the forecast amount, summed from the grid's 6 h windows starting in the period; qpfWindows counts them, 0 means no window stored). A null is 'not stated', not 0. Sky text is not ingested."
            : "temperature and wind per 12 h period; no precipitation values are stored for this grid in this window (say so if asked about rain)",
          honesty: "A rain forecast is weather at the grid cell, not a river stage or flood prediction: stage and flood categories come from river_forecast.",
          periods: rows,
          ...(rows.length === 0 ? { missing: `no NWS gridpoint forecast stored for ${site?.name ?? `${lat}, ${lon}`} in this window` } : {}),
        },
        evidenceRows,
        feeds,
        rows.length,
      ),
      { result: seriesView, more: [table], highlight: evidenceRows.map((e) => e.id), bbox: site ? sitesBox([site], 0.15) : bbox },
    );
  },
};

export const carpTools = [siteStatus, riverReadings, riverForecast, forecastVerify, reviewHistory, weatherForecast];

/** For tests: the lids this app's river tools answer for. */
export function carpLids(app: AppConfig): string[] {
  return carpSites(app).map((s) => s.lid);
}
