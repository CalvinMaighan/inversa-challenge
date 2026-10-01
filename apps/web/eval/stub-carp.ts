/**
 * Carp resolvers for the fixture GraphQL stub: the C3 forecast store queries (`forecasts`, `siteStatusAt`,
 * `forecastVerify`), the shared queries (`feeds`, `readings`, `alerts`, `board`, `evidence`) and, when the stub
 * is started with `reviewFields: true`, C5's `reviewBoard`, `siteReview` and `reviewHistory` served by the
 * TS mirror of the review rules (`server/agent/tools/review.ts`). Data: `fixtures/carp.json`
 * (built by `fixtures/carp-build.ts` from the recorded C4 payloads plus the eventful scene).
 *
 * As-of gating follows the schema: NWPS_LIVE rows are known from their `ingestedAt`, IEM_ARCHIVE rows from
 * their `issuedAt`, observations from `ingestedAt`, alerts from `firstSeenAt`.
 */

import fixture from "./fixtures/carp.json";

import { categoryOf, review, transitions, type Category, type Review, type Thresholds } from "@/server/agent/tools/review";

type BBox = { west: number; south: number; east: number; north: number };
type Vars = Record<string, unknown>;

export const CARP_FIXTURE_NOW: string = fixture.now;

type Site = (typeof fixture.sites)[keyof typeof fixture.sites];
type Snap = (typeof fixture.forecasts)[number];
type Obs = (typeof fixture.observations)[number];
type Reading = (typeof fixture.readings)[number];

const sites = fixture.sites as Record<string, Site>;
const HOUR = 3_600_000;
const PAIR_MS = 30 * 60_000;
const ms = (t: string) => Date.parse(t);
const iso = (t: number) => new Date(t).toISOString();
const r2 = (v: number) => Math.round(v * 100) / 100;
const inBox = (b: BBox, lat: number, lon: number) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
const overlaps = (a: BBox, b: BBox) => a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
const upper = (c: Category | null) => (c === null ? null : c.toUpperCase());

function siteOf(id: string): Site {
  const site = sites[id];
  if (!site) throw Object.assign(new Error(`unknown site ${id}`), { code: "UNKNOWN_SITE" });
  return site;
}

const thresholdsOf = (site: Site): Thresholds => site.thresholds;

// ---------------------------------------------------------------- readings and weather

/**
 * NWS gridpoint forecasts as modeled readings at the site's grid station (what the C4 adapter stores): per 12 h
 * period air (°C), wind (m/s, upper bound) and the chance of precipitation (%); from the raw grid the QPF (mm for the
 * window starting at the reading) and gusts (m/s, one reading per hour of each value).
 */
const weatherReadings: Reading[] = Object.entries(fixture.weather).flatMap(([lid, w]) => {
  const at = (observedAt: string, param: string, value: number | null) =>
    ({ station: lid, param, value, flag: value === null ? "MISSING" : "OK", observedAt, ingestedAt: w.updateTime, origin: "MODELED" }) as Reading;
  return [
    ...w.periods.flatMap((p) => {
      const wind = Math.max(...(p.windSpeed.match(/\d+/g) ?? ["0"]).map(Number));
      return [at(p.start, "AIR_C", r2(((p.temperatureF - 32) * 5) / 9)), at(p.start, "WIND_MS", r2(wind * 0.44704)), at(p.start, "POP_PCT", p.precipProbability)];
    }),
    ...w.qpf.map((q) => at(q.start, "RAIN_MM", q.value)),
    ...w.gusts.flatMap((g) => Array.from({ length: Math.max(1, Math.round(g.hours)) }, (_, h) => at(iso(ms(g.start) + h * HOUR), "WIND_GUST_MS", g.value === null ? null : r2(g.value / 3.6)))),
  ];
});

function readings(v: Vars) {
  const bbox = v.bbox as BBox;
  const params = Array.isArray(v.params) ? v.params.map(String) : null;
  const from = ms(String(v.from));
  const to = ms(String(v.to));
  const stations = fixture.stations as Record<string, { id: string; source: string; name: string; lat: number; lon: number; kind: string }>;
  return [...fixture.readings, ...weatherReadings]
    .filter((r) => !params || params.includes(r.param))
    .map((r) => ({ ...r, station: stations[r.station]! }))
    .filter((r) => inBox(bbox, r.station.lat, r.station.lon) && ms(r.observedAt) >= from && ms(r.observedAt) <= to)
    .map((r) => ({ station: r.station, param: r.param, value: r.value, flag: r.flag, observedAt: r.observedAt, origin: r.origin }));
}

// ---------------------------------------------------------------- alerts

function alertsAt(at: number, bbox?: BBox) {
  return fixture.alerts.filter((a) => (!bbox || overlaps(bbox, a.bbox)) && ms(a.firstSeenAt) <= at && ms(a.onset) <= at && at < ms(a.expires));
}

function alerts(v: Vars) {
  const at = ms(String(v.at));
  return alertsAt(at, v.bbox as BBox).map((a) => ({ id: a.id, event: a.event, severity: a.severity, headline: a.headline, onset: a.onset, expires: a.expires, areaGeojson: null }));
}

// ---------------------------------------------------------------- forecast store (C3)

const knownAt = (s: Snap, asOf: number) => (s.source === "IEM_ARCHIVE" ? ms(s.issuedAt) <= asOf : ms(s.ingestedAt) <= asOf);

function snapshotsKnown(site: string, asOf: number): Snap[] {
  return fixture.forecasts.filter((s) => s.site === site && knownAt(s, asOf)).sort((a, b) => ms(b.issuedAt) - ms(a.issuedAt));
}

function snapshotOut(s: Snap) {
  const th = thresholdsOf(siteOf(s.site));
  const points = s.points.map((p) => ({ validAt: p.validAt, stageFt: p.stageFt, flowKcfs: p.flowKcfs, category: upper(categoryOf(p.stageFt, th)) }));
  const peak = s.points.filter((p) => p.stageFt !== null).reduce<{ at: string; stageFt: number } | null>((best, p) => (!best || p.stageFt! > best.stageFt ? { at: p.validAt, stageFt: p.stageFt! } : best), null);
  return {
    id: `${s.site}:${ms(s.issuedAt)}`,
    site: s.site,
    product: s.product,
    issuedAt: s.issuedAt,
    ingestedAt: s.ingestedAt,
    source: s.source,
    payloadHash: `h${ms(s.issuedAt).toString(36)}`,
    revision: s.revision,
    validFrom: s.points[0]?.validAt ?? null,
    validTo: s.points[s.points.length - 1]?.validAt ?? null,
    horizonEnd: s.points[s.points.length - 1]?.validAt ?? null,
    peakStageFt: peak?.stageFt ?? null,
    peakAt: peak?.at ?? null,
    peakCategory: upper(categoryOf(peak?.stageFt ?? null, th)),
    points,
  };
}

function forecasts(v: Vars) {
  const site = siteOf(String(v.site));
  const asOf = v.asOf ? ms(String(v.asOf)) : ms(fixture.now);
  const history = Math.min(Math.max(Number(v.history ?? 1), 1), 60);
  const known = snapshotsKnown(site.lid, asOf);
  const all = fixture.forecasts.filter((s) => s.site === site.lid);
  const knowable = all.map((s) => (s.source === "IEM_ARCHIVE" ? ms(s.issuedAt) : ms(s.ingestedAt)));
  return {
    site: site.lid,
    asOf: iso(asOf),
    snapshot: known[0] ? snapshotOut(known[0]) : null,
    history: known.slice(0, history).map(snapshotOut),
    replayCoverageStart: knowable.length ? iso(Math.min(...knowable)) : null,
    liveCoverageStart: fixture.liveCoverageStart,
    snapshotCount: known.length,
  };
}

function observationsKnown(site: string, asOf: number): Obs[] {
  return fixture.observations.filter((o) => o.site === site && ms(o.ingestedAt) <= asOf);
}

const freshnessOf = (age: number | null, freshMs: number, agingMs: number) => (age === null ? "MISSING" : age <= freshMs ? "FRESH" : age <= agingMs ? "AGING" : "STALE");

function siteStatusAt(v: Vars) {
  const site = siteOf(String(v.site));
  const asOf = ms(String(v.asOf));
  const conflictFt = typeof v.conflictFt === "number" ? v.conflictFt : 1;
  const th = thresholdsOf(site);
  const known = observationsKnown(site.lid, asOf);
  const obs = known.reduce<Obs | null>((best, o) => (!best || ms(o.observedAt) > ms(best.observedAt) ? o : best), null);
  const snap = snapshotsKnown(site.lid, asOf)[0] ?? null;
  const forecast = snap ? snapshotOut(snap) : null;
  const forecastNow = forecast?.points.filter((p) => Math.abs(ms(p.validAt) - asOf) <= PAIR_MS).sort((a, b) => Math.abs(ms(a.validAt) - asOf) - Math.abs(ms(b.validAt) - asOf))[0] ?? null;
  const conflicts: { kind: string; detail: string; forecastFt: number | null; observedFt: number | null; differenceFt: number | null }[] = [];
  if (obs?.stageFt != null && forecastNow?.stageFt != null) {
    const diff = r2(obs.stageFt - forecastNow.stageFt);
    if (Math.abs(diff) > conflictFt) conflicts.push({ kind: "gauge_vs_forecast", detail: `NWPS observed ${obs.stageFt} ft at ${obs.observedAt} vs forecast ${forecastNow.stageFt} ft valid ${forecastNow.validAt} (issued ${forecast!.issuedAt}): ${diff} ft, over the ${conflictFt} ft threshold`, forecastFt: forecastNow.stageFt, observedFt: obs.stageFt, differenceFt: diff });
  }
  const obsAge = obs ? asOf - ms(obs.observedAt) : null;
  const fcAge = forecast ? asOf - ms(forecast.issuedAt) : null;
  const observationFreshness = freshnessOf(obsAge, 2 * HOUR, 6 * HOUR);
  const forecastFreshness = freshnessOf(fcAge, 24 * HOUR, 36 * HOUR);
  if (forecastFreshness === "STALE") conflicts.push({ kind: "stale_forecast", detail: `forecast issued ${forecast!.issuedAt} is ${r2(fcAge! / HOUR)} h old at ${iso(asOf)}; over 36 h`, forecastFt: null, observedFt: null, differenceFt: null });
  if (observationFreshness === "STALE") conflicts.push({ kind: "stale_observation", detail: `newest NWPS observation ${obs!.observedAt} is ${r2(obsAge! / HOUR)} h old at ${iso(asOf)}; over 6 h`, forecastFt: null, observedFt: obs!.stageFt, differenceFt: null });
  const alertsNow = alertsAt(asOf).filter((a) => a.sites.includes(site.lid));
  return {
    site: site.lid,
    asOf: iso(asOf),
    observation: obs ? { observedAt: obs.observedAt, ingestedAt: obs.ingestedAt, source: "NWPS_LIVE", stageFt: obs.stageFt, flowKcfs: obs.flowKcfs } : null,
    stageFt: obs?.stageFt ?? null,
    category: upper(categoryOf(obs?.stageFt ?? null, th)),
    thresholds: { actionFt: th.action, minorFt: th.minor, moderateFt: th.moderate, majorFt: th.major },
    observationFreshness,
    forecastFreshness,
    forecast,
    forecastNow,
    conflicts,
    activeAlerts: alertsNow.length,
  };
}

function forecastVerify(v: Vars) {
  const site = siteOf(String(v.site));
  const issuedAt = ms(String(v.issuedAt));
  const snap = fixture.forecasts.find((s) => s.site === site.lid && ms(s.issuedAt) === issuedAt);
  if (!snap) throw new Error(`no forecast for ${site.lid} issued at ${iso(issuedAt)}`);
  const th = thresholdsOf(site);
  const obs = fixture.observations.filter((o) => o.site === site.lid && o.stageFt !== null);
  const points = snap.points.map((p) => {
    const near = obs.filter((o) => Math.abs(ms(o.observedAt) - ms(p.validAt)) <= PAIR_MS).sort((a, b) => Math.abs(ms(a.observedAt) - ms(p.validAt)) - Math.abs(ms(b.observedAt) - ms(p.validAt)))[0];
    const err = near && p.stageFt !== null ? r2(p.stageFt - near.stageFt!) : null;
    return { validAt: p.validAt, forecastFt: p.stageFt, forecastCategory: upper(categoryOf(p.stageFt, th)), observedAt: near?.observedAt ?? null, observedFt: near?.stageFt ?? null, observedCategory: upper(categoryOf(near?.stageFt ?? null, th)), errorFt: err, missing: !near };
  });
  const paired = points.filter((p) => p.errorFt !== null);
  const errs = paired.map((p) => p.errorFt!);
  const peakF = snapshotOut(snap);
  const inWindow = obs.filter((o) => ms(o.observedAt) >= ms(peakF.validFrom!) && ms(o.observedAt) <= ms(peakF.validTo!));
  const peakObs = inWindow.reduce<number | null>((m, o) => (m === null || o.stageFt! > m ? o.stageFt! : m), null);
  return {
    site: site.lid,
    issuedAt: snap.issuedAt,
    snapshot: peakF,
    points,
    paired: paired.length,
    missing: points.length - paired.length,
    biasFt: errs.length ? r2(errs.reduce((a, b) => a + b, 0) / errs.length) : null,
    meanAbsErrorFt: errs.length ? r2(errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length) : null,
    maxAbsErrorFt: errs.length ? r2(Math.max(...errs.map(Math.abs))) : null,
    peakForecastFt: peakF.peakStageFt,
    peakForecastCategory: peakF.peakCategory,
    peakObservedFt: peakObs,
    peakObservedCategory: upper(categoryOf(peakObs, th)),
    peakCategoryHit: peakObs === null || peakF.peakStageFt === null ? null : categoryOf(peakObs, th) === categoryOf(peakF.peakStageFt, th),
  };
}

// ---------------------------------------------------------------- C5 review fields (TS mirror)

function reviewAt(lid: string, asOf: number): Review {
  const site = siteOf(lid);
  const status = siteStatusAt({ site: lid, asOf: iso(asOf) });
  const dayAgo = observationsKnown(lid, asOf)
    .filter((o) => Math.abs(ms(o.observedAt) - (asOf - 24 * HOUR)) <= 3 * HOUR)
    .sort((a, b) => Math.abs(ms(a.observedAt) - (asOf - 24 * HOUR)) - Math.abs(ms(b.observedAt) - (asOf - 24 * HOUR)))[0];
  const obsId = (o: Obs) => `reading:${lid}:stage_m:${ms(o.observedAt)}:measured`;
  const snap = snapshotsKnown(lid, asOf)[0];
  const obs = status.observation;
  return review({
    site: lid,
    asOf,
    tidal: lid === "MCGL1",
    thresholds: site.thresholds,
    observation: obs ? { observedAt: ms(obs.observedAt), stageFt: obs.stageFt, flowKcfs: obs.flowKcfs, evidenceId: `reading:${lid}:stage_m:${ms(obs.observedAt)}:measured` } : null,
    observationDayAgo: dayAgo ? { observedAt: ms(dayAgo.observedAt), stageFt: dayAgo.stageFt, evidenceId: obsId(dayAgo) } : null,
    forecast: snap ? { issuedAt: ms(snap.issuedAt), source: snap.source === "IEM_ARCHIVE" ? "iem-archive" : "nwps-live", points: snap.points.map((p) => ({ validAt: ms(p.validAt), stageFt: p.stageFt, flowKcfs: p.flowKcfs })), evidenceId: `forecast:${lid}:${ms(snap.issuedAt)}` } : null,
    alerts: alertsAt(asOf).filter((a) => a.sites.includes(lid)).map((a) => ({ id: a.id, event: a.event, evidenceId: `alert:${a.id}` })),
  });
}

function reviewOut(r: Review) {
  return { ...r, categoryNow: upper(r.categoryNow), categoryPeak: upper(r.categoryPeak), reasons: r.reasons.map((x) => ({ ...x, link: x.evidenceIds[0] ?? null })) };
}

function reviewBoard(v: Vars) {
  const asOf = v.asOf ? ms(String(v.asOf)) : ms(fixture.now);
  const rows = Object.keys(sites).map((lid) => reviewOut(reviewAt(lid, asOf)));
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return { asOf: iso(asOf), sites: rows, counts: { review: count("review"), ok: count("ok"), cannotAssess: count("cannot_assess") } };
}

function reviewHistory(v: Vars) {
  const lid = siteOf(String(v.site)).lid;
  const to = v.to ? ms(String(v.to)) : ms(fixture.now);
  const from = v.from ? ms(String(v.from)) : to - 7 * 24 * HOUR;
  const samples: Review[] = [];
  for (let t = from; t <= to; t += HOUR) samples.push(reviewAt(lid, t));
  return { site: lid, from: iso(from), to: iso(to), transitions: transitions(samples).map((t) => ({ ...t, rules: t.rules.map((x) => ({ ...x, link: x.evidenceIds[0] ?? null })) })) };
}

// ---------------------------------------------------------------- evidence(id)

function evidence(v: Vars) {
  const id = String(v.id);
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  const feed = (source: string) => fixture.feeds.find((f) => f.source === source) ?? null;
  const base = { id, kind, raw: null as unknown, rawKey: null as string | null, sourceUrl: null as string | null, sourcePageUrl: null as string | null, fetchedAt: null as string | null, ingestLagSeconds: null as number | null, feed: null as unknown, links: [] as { id: string; relation: string; source: string }[] };
  if (kind === "reading") {
    const [station, param, at, origin] = key.split(":");
    const t = Number(at);
    if (sites[station!]) {
      const o = fixture.observations.find((x) => x.site === station && ms(x.observedAt) === t);
      if (!o) throw new Error(`no evidence ${id}`);
      return { ...base, record: { site: station, stageFt: o.stageFt, flowKcfs: o.flowKcfs, observedAt: o.observedAt, datum: "NWPS gauge datum (the one the flood categories use)", unit: "ft" }, raw: o, sourceUrl: `https://api.water.noaa.gov/nwps/v1/gauges/${station}/stageflow`, sourcePageUrl: `https://water.noaa.gov/gauges/${station}`, fetchedAt: o.ingestedAt, ingestLagSeconds: Math.round((ms(o.ingestedAt) - ms(o.observedAt)) / 1000), feed: feed("nwps") };
    }
    const r = fixture.readings.find((x) => x.station === station && x.param.toLowerCase() === param && ms(x.observedAt) === t && x.origin.toLowerCase() === origin);
    if (!r) throw new Error(`no evidence ${id}`);
    const lid = Object.values(sites).find((s) => s.usgs === station)?.lid ?? null;
    return { ...base, record: { station, param: r.param, value: r.value, unit: r.param === "STAGE_M" ? "m (gage height, converted from ft)" : "cfs", observedAt: r.observedAt, datum: lid === "KRZL1" ? "USGS gage datum, about 2.45 ft below the NWPS datum at this site" : "USGS gage datum", approval: "Provisional" }, raw: r, sourceUrl: `https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items?monitoring_location_id=USGS-${station}&parameter_code=${r.param === "STAGE_M" ? "00065" : "00060"}`, sourcePageUrl: `https://waterdata.usgs.gov/monitoring-location/${station}/`, fetchedAt: r.ingestedAt, ingestLagSeconds: Math.round((ms(r.ingestedAt) - ms(r.observedAt)) / 1000), feed: feed("usgs"), links: lid ? [{ id: `source:usgs`, relation: "feed", source: "usgs" }] : [] };
  }
  if (kind === "forecast") {
    const [lid, at] = key.split(":");
    const s = fixture.forecasts.find((x) => x.site === lid && ms(x.issuedAt) === Number(at));
    if (!s) throw new Error(`no evidence ${id}`);
    const archive = s.source === "IEM_ARCHIVE";
    return { ...base, record: snapshotOut(s), raw: s, sourceUrl: archive ? `https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py?station=${lid}&kind=forecasts&fmt=csv` : `https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow`, sourcePageUrl: archive ? "https://mesonet.agron.iastate.edu/request/hml.php" : `https://water.noaa.gov/gauges/${lid}`, fetchedAt: s.ingestedAt, ingestLagSeconds: Math.round((ms(s.ingestedAt) - ms(s.issuedAt)) / 1000), feed: feed(archive ? "iem" : "nwps") };
  }
  if (kind === "alert") {
    const a = fixture.alerts.find((x) => x.id === key);
    if (!a) throw new Error(`no evidence ${id}`);
    return { ...base, record: a, raw: a, sourceUrl: "https://api.weather.gov/alerts/active?area=LA", sourcePageUrl: `https://alerts.weather.gov/search?id=${a.id}`, fetchedAt: a.firstSeenAt, ingestLagSeconds: 0, feed: feed("nws-alerts") };
  }
  if (kind === "fetch") {
    const f = fixture.feeds.find((x) => x.lastFetchRunId === key);
    if (!f) throw new Error(`no evidence ${id}`);
    return { ...base, record: f, raw: f, fetchedAt: f.lastFetchAt, feed: f };
  }
  const board = fixture.board;
  const row = kind === "note" ? board.notes.find((n) => n.id === key) : kind === "mission" ? board.missions.find((m) => m.id === key) : kind === "message" ? board.messages.find((m) => m.id === key) : null;
  if (!row) throw new Error(`no evidence ${id}`);
  return { ...base, record: row, raw: row };
}

// ---------------------------------------------------------------- resolvers

/** Alias groups: variables `s0..sN` name sites; the resolver answers `s<i>` (and `p<i>` at `asOf24`, `f<i>` for forecasts). */
function siteVars(v: Vars): [number, string][] {
  return Object.entries(v)
    .filter(([k]) => /^s\d+$/.test(k))
    .map(([k, val]) => [Number(k.slice(1)), String(val)] as [number, string])
    .sort((a, b) => a[0] - b[0]);
}

export function carpResolvers(options: { reviewFields?: boolean } = {}): Record<string, (v: Vars) => Record<string, unknown>> {
  const feeds = () => fixture.feeds;
  const board = (v: Vars) => ({ board: { ...fixture.board, id: String(v.id) } });
  const base: Record<string, (v: Vars) => Record<string, unknown>> = {
    AgentFeeds: () => ({ feeds: feeds() }),
    AgentFeedState: () => ({ feeds: feeds() }),
    AgentReadings: (v) => ({ readings: readings(v), feeds: feeds() }),
    AgentAlerts: (v) => ({ alerts: alerts(v), feeds: feeds() }),
    AgentNotes: board,
    AgentTeamBoard: board,
    AgentEvidence: (v) => ({ evidence: evidence(v), feeds: feeds() }),
    AgentForecastVerify: (v) => ({ forecastVerify: forecastVerify(v), feeds: feeds() }),
    AgentForecasts: (v) => ({
      ...Object.fromEntries(siteVars(v).flatMap(([i, site]) => [[`f${i}`, forecasts({ site, asOf: v.asOf, history: v.history })], [`t${i}`, siteStatusAt({ site, asOf: v.asOf ?? fixture.now })]])),
      feeds: feeds(),
    }),
    AgentRiverReadings: (v) => ({
      readings: readings(v),
      ...Object.fromEntries(siteVars(v).map(([i, site]) => [`s${i}`, siteStatusAt({ site, asOf: v.to })])),
      feeds: feeds(),
    }),
    AgentWeatherForecast: (v) => ({ readings: readings(v), feeds: feeds() }),
    AgentSiteStatus: (v) => ({
      ...Object.fromEntries(siteVars(v).flatMap(([i, site]) => [[`s${i}`, siteStatusAt({ site, asOf: v.asOf, conflictFt: v.conflictFt })], ...(v.asOf24 ? [[`p${i}`, siteStatusAt({ site, asOf: v.asOf24, conflictFt: v.conflictFt })]] : [])])),
      feeds: feeds(),
    }),
    AgentSiteStatusSeries: (v) => ({
      ...Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => /^t\d+$/.test(k))
          .map(([k, at]) => [`h${k.slice(1)}`, siteStatusAt({ site: v.site, asOf: at })]),
      ),
      feeds: feeds(),
    }),
  };
  if (!options.reviewFields) return base;
  return {
    ...base,
    AgentReviewBoard: (v) => ({ reviewBoard: reviewBoard(v), feeds: feeds() }),
    AgentSiteReview: (v) => ({ siteReview: reviewOut(reviewAt(siteOf(String(v.site)).lid, v.asOf ? ms(String(v.asOf)) : ms(fixture.now))), feeds: feeds() }),
    AgentReviewHistory: (v) => ({ reviewHistory: reviewHistory(v), feeds: feeds() }),
  };
}

/** Operation names C5 adds; a stub without `reviewFields` answers them like an API that predates C5. */
export const REVIEW_OPERATIONS = new Set(["AgentReviewBoard", "AgentSiteReview", "AgentReviewHistory"]);
