#!/usr/bin/env bun
// F1 push/poll probe. Live calls only, no keys. One `PUSH <feed> ...` line per claim tested;
// docs/ingest-modes.md quotes these lines. Usage: bun scripts/probe-push.ts

const UA = "inversa-f1-probe/0.1 (ingest-mode audit)";
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const mins = (t: number) => ((now - t) / 60_000).toFixed(0);

async function req(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, redirect: "manual" });
  const body = res.status === 304 ? "" : await res.text();
  return { status: res.status, h: res.headers, body };
}

// Conditional GET: does the provider answer 304 to its own validator?
async function conditional(feed: string, url: string) {
  const a = await req(url);
  const etag = a.h.get("etag");
  const lm = a.h.get("last-modified");
  const b = etag ? await req(url, { "If-None-Match": etag }) : lm ? await req(url, { "If-Modified-Since": lm }) : null;
  console.log(
    `PUSH ${feed} first=${a.status} validator=${etag ? "etag" : lm ? "last-modified" : "none"} conditional=${b?.status ?? "n/a"} cache-control="${a.h.get("cache-control") ?? ""}"`,
  );
  return a;
}

async function main() {
  // 1. NWS alerts: no stream; conditional GET advertised (ETag) but answered 200.
  await conditional("nws-alerts", "https://api.weather.gov/alerts/active?area=LA");
  const atom = await req("https://api.weather.gov/alerts/active.atom?area=FL");
  console.log(`PUSH nws-atom status=${atom.status} type=${atom.h.get("content-type")} (pull format, no hub link=${!/rel="hub"/.test(atom.body)})`);
  const nwws = await req("https://www.weather.gov/nwws/nwws_oi_request");
  console.log(`PUSH nwws-oi request_page=${nwws.status} ten_days=${/10.days/i.test(nwws.body)}`);

  // 2. IEMBot: public relay of NWS products (XMPP rooms, RSS, webhooks configured behind sign-in).
  for (const room of ["lixchat", "lchchat", "shvchat", "mflchat", "keychat"]) {
    const r = await req(`https://weather.im/iembot-rss/room/${room}.xml`);
    const newest = r.body.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    console.log(`PUSH iembot-rss room=${room} status=${r.status} items=${(r.body.match(/<item>/g) ?? []).length} newest="${newest ?? ""}"`);
  }
  const cfg = await req("https://weather.im/iembot/config/");
  console.log(`PUSH iembot-webhook-config status=${cfg.status} location=${(cfg.h.get("location") ?? "").slice(0, 60)}`);

  // 3. iNaturalist: no webhook; account subscriptions only; conditional GET works.
  await conditional("inat-api", "https://api.inaturalist.org/v1/observations?taxon_id=238252&place_id=21&per_page=1&order_by=updated_at");
  const sw = JSON.parse((await req("https://api.inaturalist.org/v1/swagger.json")).body);
  const subs = Object.keys(sw.paths).filter((p) => /subscri|hook/i.test(p));
  const throttle = (sw.info.description as string).match(/throttle[^.]+\./)?.[0].replace(/\s+/g, " ");
  console.log(`PUSH inat-swagger hook_paths=${subs.filter((p) => /hook/.test(p)).length} subscription_paths=${subs.join(",")}`);
  console.log(`PUSH inat-limit "${throttle}"`);

  // 4. GBIF: no webhook in the occurrence OpenAPI; download notices are email only.
  const gb = (await req("https://techdocs.gbif.org/openapi/occurrence.json")).body;
  console.log(
    `PUSH gbif-openapi webhook=${/webhook/i.test(gb)} callback=${/callback/i.test(gb)} notificationAddresses=${/notificationAddresses/.test(gb)}`,
  );
  await conditional("gbif-api", "https://api.gbif.org/v1/occurrence/search?taxonKey=4820533&limit=1");

  // 5. USGS NAS: alert e-mail + RSS of "new to a HUC" alerts, national, low volume.
  const nas = await req("https://nas.er.usgs.gov/AlertSystem/RSS.aspx");
  const nasDates = [...nas.body.matchAll(/<pubDate>([^<]+)</g)].map((m) => m[1]);
  console.log(`PUSH nas-alerts-rss status=${nas.status} items=${nasDates.length} newest="${nasDates[0] ?? ""}" oldest="${nasDates.at(-1) ?? ""}"`);

  // 6. USGS Water, NWPS: no subscription, no validators.
  await conditional("usgs-ogc", "https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items?monitoring_location_id=USGS-07381490&parameter_code=00065&time=PT2H&f=json");
  const nwps = await conditional("nwps", "https://api.water.noaa.gov/nwps/v1/gauges/SMML1/stageflow");
  const issued = [...nwps.body.matchAll(/"issuedTime":\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log(`PUSH nwps-issued observed=${issued[0]} forecast=${issued[1]}`);
  const swag = (await req("https://api.water.noaa.gov/nwps/v1/docs/swagger.json")).body;
  console.log(`PUSH nwps-swagger subscription=${/subscri|webhook|callback/i.test(swag)}`);

  // 7. NOAA CRW on ERDDAP: dataset-change subscriptions (email or URL action) and RSS.
  const sub = await req("https://pae-paha.pacioos.hawaii.edu/erddap/subscriptions/add.html");
  console.log(`PUSH crw-erddap-subscribe status=${sub.status} url_action=${/name="action"/.test(sub.body)} email_validation=${/validate your request/.test(sub.body)}`);
  const rss = await req("https://pae-paha.pacioos.hawaii.edu/erddap/rss/dhw_5km.rss");
  console.log(`PUSH crw-erddap-rss status=${rss.status} changed="${rss.body.match(/This dataset changed ([^<]+)</)?.[1] ?? ""}"`);
  const last = (await req("https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.csv?time%5B(last)%5D")).body.trim().split("\n").at(-1)!;
  console.log(`PUSH crw-latest time=${last} lag_h=${((now - Date.parse(last)) / 3_600_000).toFixed(1)}`);

  // 8. Open-Meteo: no push; meta.json says when each model run became available.
  for (const [host, m] of [
    ["api", "ncep_hrrr_conus"],
    ["api", "ncep_gfs013"],
    ["marine-api", "ncep_gfswave025"],
    ["marine-api", "meteofrance_wave"],
    ["marine-api", "meteofrance_currents"],
  ]) {
    const j = JSON.parse((await req(`https://${host}.open-meteo.com/data/${m}/static/meta.json`)).body);
    console.log(
      `PUSH openmeteo-meta model=${m} run=${iso(j.last_run_initialisation_time * 1000)} available=${iso(j.last_run_availability_time * 1000)} interval_h=${j.update_interval_seconds / 3600}`,
    );
  }

  // 9. NDBC: one bulk file for all stations, Last-Modified + 304.
  const lo = await conditional("ndbc-latest-obs", "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt");
  console.log(`PUSH ndbc-latest-obs stations=${lo.body.split("\n").filter((l) => l && !l.startsWith("#")).length} last_modified="${lo.h.get("last-modified")}"`);
  await conditional("ndbc-realtime2", "https://www.ndbc.noaa.gov/data/realtime2/42036.txt");

  // 10. CO-OPS: no push, no validators; measure lag of the latest 6-min value.
  const co = await req("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=8723214&product=water_temperature&date=latest&units=metric&time_zone=gmt&format=json");
  const t = JSON.parse(co.body).data?.[0]?.t as string | undefined;
  console.log(`PUSH coops status=${co.status} cache-control="${co.h.get("cache-control")}" latest=${t} lag_min=${t ? mins(Date.parse(t.replace(" ", "T") + ":00Z")) : "?"}`);

  // 11. GOES-19: SNS topic on the AWS registry (SQS/Lambda only); product latency from S3 keys.
  const reg = (await req("https://registry.opendata.aws/noaa-goes/")).body;
  console.log(`PUSH goes19-sns topic=${reg.includes("NewGOES19Object")} only_lambda_sqs=${/only Lambda and SQS protocols allowed/.test(reg)}`);
  const d = new Date(now);
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
  for (const p of ["ABI-L2-LSTC", "ABI-L2-SSTF", "ABI-L2-FDCC", "ABI-L2-ACMC"]) {
    let keys: string[] = [];
    for (let back = 0; back < 3 && keys.length === 0; back++) {
      const hh = String(d.getUTCHours() - back).padStart(2, "0");
      const x = (await req(`https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=${p}/${d.getUTCFullYear()}/${doy}/${hh}/`)).body;
      keys = [...x.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    }
    const k = keys.at(-1) ?? "";
    const ts = (tag: string) => {
      const s = k.match(new RegExp(`_${tag}(\\d{4})(\\d{3})(\\d{2})(\\d{2})(\\d{2})`));
      return s ? Date.UTC(+s[1], 0, +s[2], +s[3], +s[4], +s[5]) : NaN;
    };
    console.log(`PUSH goes19-s3 product=${p} files_this_hour=${keys.length} scan_end_to_created_min=${((ts("c") - ts("e")) / 60_000).toFixed(1)} created_age_min=${mins(ts("c"))}`);
  }
  console.log(`PUSH done at=${iso(now)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
