#!/usr/bin/env bun
// Carp C1 data proof. Live calls only, no keys.
// Per site: SITE, OBS, FCST, NWS (gate lines) plus DATUM, THRESH, AGE, ARCHIVE (evidence lines).
// Usage: bun scripts/probe-carp.ts [--sites=SMML1,BTRL1]

type Site = { lid: string; usgs: string; why: string };

// NWPS lid -> USGS site number. NWPS `usgsId` is empty for most Louisiana gauges, so the
// mapping is ours: the USGS gauge at the same station (checked by DATUM below, same stage).
export const SITES: Site[] = [
  // Atchafalaya Basin first: L'CARP is "currently only active in the Atchafalaya Basin".
  { lid: "SMML1", usgs: "07381490", why: "Atchafalaya head, below Old River outflow" },
  { lid: "KRZL1", usgs: "07381500", why: "Atchafalaya at Krotz Springs, upper basin" },
  { lid: "BLRL1", usgs: "07381515", why: "Atchafalaya above Butte La Rose, mid basin" },
  { lid: "MCGL1", usgs: "07381600", why: "Lower Atchafalaya at Morgan City, tidal" },
  // Feeder and neighbour rivers named in the brief.
  { lid: "BTRL1", usgs: "07374000", why: "Mississippi at Baton Rouge" },
  { lid: "AEXL1", usgs: "07355500", why: "Red River at Alexandria" },
  { lid: "MLUL1", usgs: "07367005", why: "Ouachita at Monroe" },
  { lid: "BXAL1", usgs: "02489500", why: "Pearl near Bogalusa" },
];

const NWPS = "https://api.water.noaa.gov/nwps/v1/gauges/";
const USGS = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items";
const NWS = "https://api.weather.gov";
const IEM_HML = "https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py";

// api.weather.gov rejects requests without a User-Agent.
const UA = { "User-Agent": "inversa-carp-probe/0.1 (data proof)", Accept: "application/geo+json, application/json" };
const H = 3_600_000;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hoursAgo = (ts: string | null) => (ts ? +((now - Date.parse(ts)) / H).toFixed(1) : NaN);
const r2 = (v: number) => (Number.isFinite(v) ? +v.toFixed(2) : "none");

// One request in flight per host, 250 ms apart: polite and well under any published limit.
const nextSlot: Record<string, number> = {};
async function get(url: string, kind: "json" | "text" = "json", tries = 4): Promise<any> {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    const slot = Math.max(nextSlot[host] ?? 0, Date.now());
    nextSlot[host] = slot + 250;
    await sleep(slot - Date.now());
    const res = await fetch(url, { headers: UA });
    if (res.ok) return kind === "json" ? res.json() : res.text();
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * (i + 1));
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`gave up ${url}`);
}

// ---------- USGS (OGC API continuous; the legacy waterservices IV 503s on multi-site calls) ----------
// Anonymous use is rate limited per IP (no key in Doppler), so every site and both
// parameters go in one query, following `next` links: 1-2 requests per run.
type Pt = { t: string; v: number };
let usgsCalls = 0;
async function usgsAll(sites: string[]): Promise<Map<string, Pt[]>> {
  const out = new Map<string, Pt[]>();
  let url: string | undefined =
    `${USGS}?f=json&monitoring_location_id=${sites.map((s) => "USGS-" + s).join(",")}&parameter_code=00065,00060` +
    `&time=P7D&limit=10000&properties=monitoring_location_id,parameter_code,time,value&skipGeometry=true`;
  while (url) {
    const j = await get(url);
    usgsCalls++;
    for (const f of j.features as any[]) {
      const p = f.properties;
      const v = Number(p.value);
      // USGS uses -999999 for "no value"; null would parse to 0, so test the raw value too.
      if (p.value == null || !Number.isFinite(v) || v <= -999) continue;
      const k = `${p.monitoring_location_id.slice(5)}:${p.parameter_code}`;
      (out.get(k) ?? out.set(k, []).get(k)!).push({ t: iso(Date.parse(p.time)), v });
    }
    url = (j.links as any[]).find((l) => l.rel === "next")?.href;
  }
  for (const s of out.values()) s.sort((a, b) => a.t.localeCompare(b.t));
  return out;
}
// Change over 24 h: newest minus the reading closest to newest-24h, if one exists within 1 h.
function change24(s: Pt[]) {
  if (!s.length) return NaN;
  const last = s.at(-1)!;
  const target = Date.parse(last.t) - 24 * H;
  let best: Pt | null = null;
  for (const p of s) if (!best || Math.abs(Date.parse(p.t) - target) < Math.abs(Date.parse(best.t) - target)) best = p;
  return best && Math.abs(Date.parse(best.t) - target) <= H ? last.v - best.v : NaN;
}

// ---------- NWPS ----------
type Cats = { action: number; minor: number; moderate: number; major: number };
const cat = (c: any) => (c && c.stage > -999 ? c.stage : NaN);
function classify(ft: number, c: Cats) {
  for (const k of ["major", "moderate", "minor", "action"] as const) if (Number.isFinite(c[k]) && ft >= c[k]) return k;
  return "none";
}

// ---------- NWS ----------
async function nws(lat: number, lon: number) {
  const p = (await get(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`)).properties;
  const f = (await get(p.forecast)).properties;
  const a = await get(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
  return {
    grid: `${p.gridId}/${p.gridX},${p.gridY}`,
    updated: f.updateTime as string,
    generated: f.generatedAt as string,
    periods: f.periods.length as number,
    alerts: a.features.length as number,
    events: [...new Set(a.features.map((x: any) => x.properties.event))].join("|") || "none",
  };
}

// ---------- IEM HML archive (third party copy of the NWS HML forecast products) ----------
async function archive(lid: string) {
  const sts = iso(now - 7 * 24 * H).slice(0, 16);
  const csv: string = await get(`${IEM_HML}?station=${lid}&sts=${sts}Z&ets=${iso(now).slice(0, 16)}Z&kind=forecasts&fmt=csv`, "text");
  const issued = [...new Set(csv.trim().split("\n").slice(1).map((l) => l.split(",")[1]))].filter(Boolean).sort();
  return { n: issued.length, first: issued[0] ?? "none", last: issued.at(-1) ?? "none" };
}

async function probe(s: Site, log: (l: string) => void) {
  const g = await get(NWPS + s.lid);
  const sf = await get(NWPS + s.lid + "/stageflow");
  const lat = +g.latitude.toFixed(4);
  const lon = +g.longitude.toFixed(4);
  const c: Cats = {
    action: cat(g.flood?.categories?.action),
    minor: cat(g.flood?.categories?.minor),
    moderate: cat(g.flood?.categories?.moderate),
    major: cat(g.flood?.categories?.major),
  };
  const floodCats = [c.action, c.minor, c.moderate, c.major].every(Number.isFinite);

  const stage = usgs.get(`${s.usgs}:00065`) ?? [];
  const disch = usgs.get(`${s.usgs}:00060`) ?? [];
  const stageNew = stage.at(-1) ?? null;
  const dischNew = disch.at(-1) ?? null;
  const stageOk = !!stageNew && hoursAgo(stageNew.t) <= 6;
  const dischOk = !!dischNew && hoursAgo(dischNew.t) <= 6;

  const fc = (sf.forecast?.data ?? []).filter((d: any) => d.primary > -999);
  const issued: string | null = fc.length ? sf.forecast.issuedTime : null;
  // NWPS forecasts are issued once a day in normal flow, so > 36 h means a missed issuance.
  const fcstOk = fc.length > 0 && hoursAgo(issued) <= 36;
  const peak = fc.length ? Math.max(...fc.map((d: any) => d.primary)) : NaN;

  let w: Awaited<ReturnType<typeof nws>> | null = null;
  try {
    w = await nws(lat, lon);
  } catch (e) {
    log(`ERR ${s.lid} nws ${(e as Error).message}`);
  }

  log(
    `SITE ${s.lid} name=${JSON.stringify(g.name)} lat=${lat} lon=${lon} usgs=${s.usgs || "none"} nwps=${g.lid} nws=${w?.grid ?? "none"}` +
      ` stage_ok=${stageOk ? "yes" : "no"} disch_ok=${dischOk ? "yes" : "no"} fcst_ok=${fcstOk ? "yes" : "no"} flood_cats=${floodCats ? "yes" : "no"}`,
  );
  log(
    `OBS ${s.lid} n=${stage.length} newest=${stageNew?.t ?? "none"} stage_ft=${stageNew?.v ?? "none"} disch_cfs=${dischNew?.v ?? "none"} change24h_ft=${r2(change24(stage))}`,
  );
  log(
    `FCST ${s.lid} issued=${issued ?? "none"} valid_from=${fc[0]?.validTime ?? "none"} valid_to=${fc.at(-1)?.validTime ?? "none"}` +
      ` points=${fc.length} peak_ft=${r2(peak)} category=${fc.length ? classify(peak, c) : "none"}`,
  );
  log(`NWS ${s.lid} forecast_updated=${w?.updated ?? "none"} periods=${w?.periods ?? 0} alerts=${w?.alerts ?? 0}`);

  // Evidence lines (not gated).
  // DATUM: USGS vs NWPS observed stage at the same timestamp. Flood categories are on the
  // NWPS stage, so they only apply to the USGS series if the two agree.
  const obs = (sf.observed?.data ?? []).filter((d: any) => d.primary > -999);
  const byT = new Map(stage.map((p) => [p.t, p.v]));
  const pair = [...obs].reverse().find((d: any) => byT.has(iso(Date.parse(d.validTime))));
  const nwpsLast = obs.at(-1);
  const diff = pair ? byT.get(iso(Date.parse(pair.validTime)))! - pair.primary : NaN;
  log(
    `DATUM ${s.lid} usgs_id_in_nwps=${g.usgsId || "empty"} at=${pair ? iso(Date.parse(pair.validTime)) : "none"}` +
      ` usgs_ft=${pair ? byT.get(iso(Date.parse(pair.validTime))) : "none"} nwps_ft=${pair?.primary ?? "none"}` +
      ` diff_ft=${r2(diff)} same_datum=${Number.isFinite(diff) ? (Math.abs(diff) <= 0.5 ? "yes" : "no") : "unknown"}` +
      ` nwps_flow=${nwpsLast && nwpsLast.secondary > -999 ? `${nwpsLast.secondary}${sf.observed.secondaryUnits}` : "none"}` +
      ` usgs_flow_cfs=${dischNew?.v ?? "none"}`,
  );
  log(
    `THRESH ${s.lid} action=${c.action} minor=${c.minor} moderate=${c.moderate} major=${c.major} unit=${g.flood?.stageUnits}` +
      ` nwps_status_obs=${g.status?.observed?.floodCategory} nwps_status_fcst=${g.status?.forecast?.floodCategory} wfo=${g.wfo?.abbreviation} rfc=${g.rfc?.abbreviation} tz=${g.timeZone}`,
  );
  log(
    `AGE ${s.lid} usgs_stage_h=${hoursAgo(stageNew?.t ?? null)} usgs_disch_h=${hoursAgo(dischNew?.t ?? null)} nwps_obs_h=${hoursAgo(nwpsLast?.validTime ?? null)}` +
      ` fcst_issued_h=${hoursAgo(issued)} nws_updated_h=${hoursAgo(w?.updated ?? null)} nws_generated_h=${hoursAgo(w?.generated ?? null)} alert_events=${w?.events ?? "none"}`,
  );
  try {
    const a = await archive(s.lid);
    log(`ARCHIVE ${s.lid} source=iem_hml issuances_7d=${a.n} first=${a.first} last=${a.last}`);
  } catch (e) {
    log(`ERR ${s.lid} archive ${(e as Error).message}`);
  }
}

const only = process.argv.find((a) => a.startsWith("--sites="))?.slice(8).split(",");
const sites = only ? SITES.filter((s) => only.includes(s.lid)) : SITES;
console.log(`RUN at=${iso(now)} sites=${sites.length}`);
const usgs = await usgsAll(sites.map((s) => s.usgs));
// Sites run concurrently; per-host slots keep each API at <= 4 req/s.
const out = await Promise.all(
  sites.map(async (s) => {
    const lines: string[] = [];
    try {
      await probe(s, (l) => lines.push(l));
    } catch (e) {
      lines.push(`ERR ${s.lid} ${(e as Error).message}`);
    }
    return lines;
  }),
);
for (const l of out.flat()) console.log(l);
// Alerts are 0 at most points most days; state-wide and national counts show the endpoint is live.
const la = (await get(`${NWS}/alerts/active?area=LA`)).features.length;
const us = (await get(`${NWS}/alerts/active`)).features.length;
console.log(`ALERTS la_active=${la} us_active=${us} usgs_requests=${usgsCalls}`);
