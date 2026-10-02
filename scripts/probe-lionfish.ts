#!/usr/bin/env bun
// Lionfish Watch L1 data proof. Live calls only, no keys.
// Prints AREA / CRW / MARINE / COVER lines per area, then DUP and LAG summaries.
// Usage: bun scripts/probe-lionfish.ts [--areas=fl,mx]

type Area = {
  id: string;
  name: string;
  bbox: [number, number, number, number]; // west, south, east, north
  point: [number, number]; // lat, lon of a reef pixel for CRW and marine
};

export const AREAS: Area[] = [
  // Florida Keys + SE Florida reef tract up to Jupiter; Dry Tortugas included.
  { id: "fl", name: "Florida Keys / South Florida", bbox: [-83.2, 24.3, -79.8, 27.5], point: [24.55, -81.4] },
  // Quintana Roo coast, Cozumel, Isla Mujeres, Holbox, Banco Chinchorro. South edge stops at Belize border.
  { id: "mx", name: "Mexican Caribbean", bbox: [-87.9, 18.3, -86.6, 21.7], point: [18.6, -87.3] },
  // Belize barrier reef, Turneffe, Lighthouse, Glover's. North edge below Xcalak/Chinchorro,
  // south edge above Guatemala (Livingston 15.8N), east edge west of Utila (-86.9) keeps Honduras out.
  { id: "bz", name: "Belize", bbox: [-88.5, 16.0, -87.3, 18.2], point: [16.8, -87.8] },
  // San Andres / Providencia plus the Cartagena, Rosario, Barranquilla and Santa Marta/Tayrona coast.
  // South edge 9.7N keeps Panama's Colon/San Blas coast out.
  { id: "co", name: "Colombian Caribbean", bbox: [-81.8, 9.7, -74.0, 13.5], point: [12.5, -81.65] },
];

const INAT = "https://api.inaturalist.org/v1/observations";
const PTEROIS_INAT = 47284; // genus Pterois
const GBIF = "https://api.gbif.org/v1/occurrence/search";
const PTEROIS_GBIF = 2334432; // genus Pterois
const GBIF_INAT_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7";
const NAS = "https://nas.er.usgs.gov/api/v2/occurrence/search";
// CRW 5 km daily v3.1 on ERDDAP. coastwatch.pfeg 302-redirects to PacIOOS, so call PacIOOS directly.
const CRW_ERDDAP = "https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km";
const MARINE = "https://marine-api.open-meteo.com/v1/marine";
const NDBC_STATIONS = "https://www.ndbc.noaa.gov/activestations.xml";
const NDBC_RT = "https://www.ndbc.noaa.gov/data/realtime2/";
const COOPS_WATERTEMP = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=watertemp";
const GOES_BUCKET = "https://noaa-goes19.s3.amazonaws.com/";
const GOES19_SUBLON = -75.2;

const UA = { "User-Agent": "lionfish-watch-probe/0.1 (data proof)" };
const DAY = 86_400_000;
const now = new Date();
const today = now.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// iNat asks for <= 1 req/s across the whole client: reserve slots synchronously so
// concurrent areas share one queue.
let nextInat = 0;
async function getJson(url: string, opts: { inat?: boolean; tries?: number } = {}): Promise<any> {
  const tries = opts.tries ?? 3;
  for (let i = 0; i < tries; i++) {
    if (opts.inat) {
      const slot = Math.max(nextInat, Date.now());
      nextInat = slot + 1000;
      await sleep(slot - Date.now());
    }
    const res = await fetch(url, { headers: UA, redirect: "follow" });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (i + 1));
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`gave up ${url}`);
}

const inBox = (b: Area["bbox"], lat: number, lon: number, pad = 0) =>
  lon >= b[0] - pad && lon <= b[2] + pad && lat >= b[1] - pad && lat <= b[3] + pad;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

// ---------- iNaturalist ----------
const inatBox = (a: Area) => `swlat=${a.bbox[1]}&swlng=${a.bbox[0]}&nelat=${a.bbox[3]}&nelng=${a.bbox[2]}`;
const inatBase = (a: Area, introduced = true) =>
  `${INAT}?taxon_id=${PTEROIS_INAT}&${inatBox(a)}${introduced ? "&introduced=true" : ""}`;

async function inatCount(q: string) {
  return (await getJson(`${q}&per_page=0`, { inat: true })).total_results as number;
}

type InatObs = { id: number; observed_on: string | null; created_at: string; quality_grade: string };

async function inatList(q: string, max = 1000): Promise<InatObs[]> {
  const out: InatObs[] = [];
  for (let page = 1; out.length < max; page++) {
    const j = await getJson(`${q}&per_page=200&page=${page}&order_by=id&order=desc`, { inat: true });
    out.push(...j.results.map((r: any) => ({ id: r.id, observed_on: r.observed_on, created_at: r.created_at, quality_grade: r.quality_grade })));
    if (j.results.length < 200) break;
  }
  return out;
}

// ---------- GBIF ----------
const gbifBox = (a: Area) => `decimalLatitude=${a.bbox[1]},${a.bbox[3]}&decimalLongitude=${a.bbox[0]},${a.bbox[2]}`;
async function gbifCount(a: Area, extra = "") {
  return (await getJson(`${GBIF}?taxonKey=${PTEROIS_GBIF}&${gbifBox(a)}&occurrenceStatus=PRESENT&limit=0${extra}`)).count as number;
}

// ---------- USGS NAS (one global pull, filtered locally: the API has no bbox) ----------
let nasCache: any[] | null = null;
async function nasAll() {
  if (nasCache) return nasCache;
  // ~12.4k records; a 5000-row page takes ~25 s server side, so fetch 4 pages at once,
  // then continue sequentially if the last one came back full.
  const page = (offset: number) => getJson(`${NAS}?genus=Pterois&offset=${offset}&limit=4000`).then((j) => j.results as any[]);
  const pages = await Promise.all([0, 4000, 8000, 12000].map(page));
  const out = pages.flat();
  for (let offset = 16000, last = pages[3]; last.length === 4000; offset += 4000) {
    last = await page(offset);
    out.push(...last);
  }
  return (nasCache = out);
}
const nasDate = (r: any) =>
  r.year ? `${r.year}-${String(r.month ?? 1).padStart(2, "0")}-${String(r.day ?? 1).padStart(2, "0")}` : "";

// ---------- CRW ----------
async function crw(a: Area) {
  const [lat, lon] = a.point;
  const sel = `[(last)][(${lat})][(${lon})]`;
  const vars = ["CRW_SST", "CRW_SSTANOMALY", "CRW_DHW", "CRW_BAA"].map((v) => v + encodeURIComponent(sel)).join(",");
  const url = `${CRW_ERDDAP}.json?${vars}`;
  const j = await getJson(url);
  const cols: string[] = j.table.columnNames;
  const row: any[] = j.table.rows[0];
  const g = (n: string) => row[cols.indexOf(n)];
  return { url, date: String(g("time")).slice(0, 10), lat: g("latitude"), lon: g("longitude"), sst: g("CRW_SST"), anomaly: g("CRW_SSTANOMALY"), dhw: g("CRW_DHW"), baa: g("CRW_BAA") };
}

// ---------- Open-Meteo Marine ----------
async function marine(a: Area) {
  const [lat, lon] = a.point;
  const url = `${MARINE}?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,ocean_current_velocity,ocean_current_direction&forecast_days=3&timezone=GMT`;
  const j = await getJson(url);
  const h = j.hourly;
  const idx = Math.max(0, h.time.findIndex((t: string) => t >= now.toISOString().slice(0, 13)));
  const valid = h.time.filter((_: string, i: number) => h.wave_height[i] != null && h.ocean_current_velocity[i] != null).length;
  return {
    url,
    wave: h.wave_height[idx],
    period: h.wave_period[idx],
    current: h.ocean_current_velocity[idx],
    currentUnit: j.hourly_units.ocean_current_velocity,
    dir: h.ocean_current_direction[idx],
    hours: valid,
  };
}

// ---------- Coverage ----------
let ndbcCache: { id: string; lat: number; lon: number }[] | null = null;
async function ndbcStations() {
  if (ndbcCache) return ndbcCache;
  const xml = await (await fetch(NDBC_STATIONS, { headers: UA })).text();
  ndbcCache = [...xml.matchAll(/<station id="([^"]+)" lat="([^"]+)" lon="([^"]+)"/g)].map((m) => ({ id: m[1], lat: +m[2], lon: +m[3] }));
  return ndbcCache;
}

// Fresh WTMP within 3 days from realtime2 (first 4 KB is enough: newest rows come first).
async function ndbcWtmp(id: string): Promise<{ t: string; c: number } | null> {
  const res = await fetch(`${NDBC_RT}${id.toUpperCase()}.txt`, { headers: { ...UA, Range: "bytes=0-4095", "Accept-Encoding": "identity" } });
  if (!res.ok && res.status !== 206) return null;
  const lines = (await res.text()).split("\n");
  const head = lines[0].replace(/^#/, "").trim().split(/\s+/);
  const wi = head.indexOf("WTMP");
  if (wi < 0) return null;
  for (const l of lines.slice(2)) {
    const f = l.trim().split(/\s+/);
    if (f.length <= wi || f[wi] === "MM") continue;
    const t = Date.UTC(+f[0], +f[1] - 1, +f[2], +f[3], +f[4]);
    if (now.getTime() - t > 3 * DAY) return null;
    return { t: new Date(t).toISOString(), c: +f[wi] };
  }
  return null;
}

let coopsCache: { id: string; lat: number; lng: number }[] | null = null;
async function coopsWatertemp() {
  return (coopsCache ??= (await getJson(COOPS_WATERTEMP)).stations);
}

let goesSstfCache: string | null | undefined;
async function goesLatestSstf() {
  if (goesSstfCache !== undefined) return goesSstfCache;
  // Today, then yesterday (just after 00 UTC today's prefix can be empty).
  for (const back of [0, 1]) {
    const d = new Date(now.getTime() - back * DAY);
    const doy = String(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / DAY)).padStart(3, "0");
    const xml = await (await fetch(`${GOES_BUCKET}?list-type=2&prefix=ABI-L2-SSTF/${d.getUTCFullYear()}/${doy}/`, { headers: UA })).text();
    const key = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).at(-1);
    if (key) return (goesSstfCache = key);
  }
  return (goesSstfCache = null);
}
// Great-circle angle from GOES-19 sub-satellite point; ABI full disk usable SST to ~67 deg.
function goesAngle(lat: number, lon: number) {
  const r = Math.PI / 180;
  return Math.acos(Math.cos(lat * r) * Math.cos((lon - GOES19_SUBLON) * r)) / r;
}

// ---------- main ----------
const only = process.argv.find((a) => a.startsWith("--areas="))?.slice(8).split(",");
const areas = only ? AREAS.filter((a) => only.includes(a.id)) : AREAS;
const lagsAll: number[] = [];

async function probe(a: Area, log: (s: string) => void) {
  const base = inatBase(a);
  const inat7 = await inatCount(`${base}&d1=${daysAgo(7)}`);
  const inat30 = await inatCount(`${base}&d1=${daysAgo(30)}`);
  const inat90 = await inatCount(`${base}&d1=${daysAgo(90)}`);
  const inat90NoIntro = await inatCount(`${inatBase(a, false)}&d1=${daysAgo(90)}`);
  const inatAll = await inatCount(base);
  const inatRgAll = await inatCount(`${base}&quality_grade=research`);
  const created90 = await inatCount(`${base}&created_d1=${daysAgo(90)}`);
  const newestObs = (await getJson(`${base}&per_page=1&order_by=observed_on&order=desc`, { inat: true })).results[0]?.observed_on ?? "none";
  const newestCreated = (await getJson(`${base}&per_page=1&order_by=created_at&order=desc`, { inat: true })).results[0]?.created_at?.slice(0, 10) ?? "none";

  // Lag: everything submitted in the last 90 days, observed date vs created date.
  const recent = await inatList(`${base}&created_d1=${daysAgo(90)}`);
  const lags = recent
    .filter((o) => o.observed_on)
    .map((o) => (Date.parse(o.created_at) - Date.parse(o.observed_on + "T12:00:00Z")) / DAY)
    .map((d) => Math.max(0, Math.round(d)));
  lagsAll.push(...lags);
  const backfill = lags.filter((d) => d > 30).length;

  const gbif = await gbifCount(a);
  const gbifFromInat = await gbifCount(a, `&datasetKey=${GBIF_INAT_DATASET}`);
  const gbif90 = await gbifCount(a, `&eventDate=${daysAgo(90)},${today}`);

  const nasRows = (await nasAll()).filter((r) => r.decimalLatitude != null && inBox(a.bbox, +r.decimalLatitude, +r.decimalLongitude));
  const nas = nasRows.length;
  const nasNewest = nasRows.map(nasDate).sort().at(-1) ?? "none";
  const nasStates = [...new Set(nasRows.map((r) => r.state))].join("|");

  log(
    `AREA ${a.id} inat7=${inat7} inat30=${inat30} inat90=${inat90} gbif=${gbif} nas=${nas} newest_obs=${newestObs} newest_created=${newestCreated}` +
      ` | inat90_no_introduced=${inat90NoIntro} inat_all=${inatAll} inat_rg_all=${inatRgAll} inat_created90=${created90}` +
      ` gbif_from_inat=${gbifFromInat} gbif90=${gbif90} nas_newest=${nasNewest} nas_states=${nasStates}` +
      ` bbox=${a.bbox.join(",")}`,
  );
  log(
    `LAG ${a.id} n=${lags.length} median_days=${pct(lags, 0.5)} p90_days=${pct(lags, 0.9)} max_days=${lags.length ? Math.max(...lags) : NaN} submitted_gt30d_after=${backfill}`,
  );

  // Duplicate overlap: research-grade iNat ids in the area vs GBIF iNat-dataset catalogNumbers.
  const rg = recent.filter((o) => o.quality_grade === "research").slice(0, 100);
  if (rg.length) {
    const cat = rg.map((o) => `&catalogNumber=${o.id}`).join("");
    const j = await getJson(`${GBIF}?datasetKey=${GBIF_INAT_DATASET}${cat}&limit=300`);
    const hit = new Set(j.results.map((r: any) => String(r.catalogNumber)));
    log(`DUP ${a.id} inat_rg_created90=${rg.length} found_in_gbif=${hit.size} gbif_share_from_inat=${gbif ? ((100 * gbifFromInat) / gbif).toFixed(1) : "0"}%`);
  } else {
    log(`DUP ${a.id} inat_rg_created90=0 found_in_gbif=0 gbif_share_from_inat=${gbif ? ((100 * gbifFromInat) / gbif).toFixed(1) : "0"}%`);
  }

  try {
    const c = await crw(a);
    log(
      `CRW ${a.id} date=${c.date} sst=${c.sst} anomaly=${c.anomaly} dhw=${c.dhw} baa=${c.baa} cell=${c.lat},${c.lon} format=ERDDAP-griddap-json url=${c.url}`,
    );
  } catch (e) {
    log(`CRW_FAIL ${a.id} ${e}`);
  }

  try {
    const m = await marine(a);
    log(
      `MARINE ${a.id} wave=${m.wave} current=${m.current} hours=${m.hours} period_s=${m.period} current_unit=${m.currentUnit} current_dir=${m.dir} url=${m.url}`,
    );
  } catch (e) {
    log(`MARINE_FAIL ${a.id} ${e}`);
  }

  // Coverage: NAS outside Florida, buoys with fresh SST within 1 degree, GOES-19 full-disk SST.
  const near = (await ndbcStations()).filter((s) => inBox(a.bbox, s.lat, s.lon, 1));
  const fresh: string[] = [];
  for (let i = 0; i < near.length; i += 6) {
    const got = await Promise.all(near.slice(i, i + 6).map(async (s) => ((await ndbcWtmp(s.id).catch(() => null)) ? s.id : null)));
    fresh.push(...(got.filter(Boolean) as string[]));
  }
  const coops = (await coopsWatertemp()).filter((s) => inBox(a.bbox, s.lat, s.lng, 1)).length;
  const sstf = await goesLatestSstf();
  const ang = goesAngle(a.point[0], a.point[1]);
  const goes = sstf && ang < 67 ? "yes" : "no";
  log(
    `COVER ${a.id} nas=${nas > 0 ? "yes" : "no"} buoys=${fresh.length} goes_sst=${goes} | ndbc_listed_within_1deg=${near.length} ndbc_wtmp_fresh=${fresh.join(",") || "none"} coops_watertemp_within_1deg=${coops} goes_angle_deg=${ang.toFixed(1)} goes_latest=${sstf ?? "none"}`,
  );
}

// Shared pulls once, then areas in parallel (iNat calls still go through the 1 req/s queue).
await Promise.all([nasAll(), ndbcStations(), coopsWatertemp(), goesLatestSstf()]);
const outputs = await Promise.all(
  areas.map(async (a) => {
    const lines: string[] = [];
    try {
      await probe(a, (s) => lines.push(s));
    } catch (e) {
      lines.push(`FAIL ${a.id} ${e}`);
    }
    return lines;
  }),
);
for (const lines of outputs) for (const l of lines) console.log(l);

if (lagsAll.length) {
  console.log(`LAG all n=${lagsAll.length} median_days=${pct(lagsAll, 0.5)} p90_days=${pct(lagsAll, 0.9)}`);
}
console.log(`RUN at=${now.toISOString()}`);
