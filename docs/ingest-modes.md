# Ingest modes: push, webhook or poll, per feed per app (F1)

Status: 2026-10-01. Audit for the three-app pivot (carp, lionfish, python). Applies R15 in `docs/OVERNIGHT_BRIEF.md`: use push or a webhook where the provider has one; poll only feeds that are rich, useful and frequent and have no push API.

Evidence: `bun scripts/probe-push.ts` (run 2026-10-01T05:27:42Z) prints one `PUSH …` line per claim. Numbers below come from that run, `docs/evidence/carp-data-proof.md` (C1) and `docs/evidence/data-proof.md` (L1). Re-run the script to refresh them.

## Terms

- **push**: the provider sends us each new item over a long-lived channel: SNS to SQS (GOES-19) or XMPP (NWWS-OI).
- **webhook**: the provider calls a URL of ours when something changes. All three webhooks found here (ERDDAP, IEMBot, and our own emitters) are untrusted or unsigned except our own, so a third-party call is a **nudge**: it wakes the emitter for that source at once and carries no data we trust (see "Nudges").
- **poll**: our emitter fetches on a schedule. Every poll row says what push search was done and where.
- **emitter**: the scheduled job that fetches, archives and delivers a payload through the signed hook. Designed: every feed lands through `POST /v1/{app}/ingest/hook/{source}`, push sources included (section "Emitter design"). As built: emitters inside the API process call the same pipeline directly, and the hook serves emitters in another process (section "As built").

## Verdict in one table

| Feed | Push or webhook found? | Mode we use |
|---|---|---|
| GOES-19 (LST, SST, fire, cloud) | yes: SNS `NewGOES19Object`, SQS or Lambda subscribers only | **push** (SNS to SQS) |
| NWS products and alerts | yes: NWWS-OI XMPP (account by email, 10+ days); IEMBot webhooks (third party, sign-in) | **push** (NWWS-OI) + **nudge** (IEMBot) + 60 s poll as backstop |
| NOAA Coral Reef Watch | yes: ERDDAP dataset-change subscription with a URL action (email validation) | **webhook nudge** + 3 h poll as backstop |
| NOAA NWPS river forecasts | no | **poll**, fast in the daily issuance window; nudged by IEMBot flood products |
| USGS Water Data | no (WaterAlert is email/SMS to a person) | **poll** 15 min |
| iNaturalist | no (only account subscriptions to one observation or project) | **poll** 10 min, conditional GET |
| GBIF | no (download notices are email only) | **poll** daily |
| USGS NAS | no (alert email + national RSS of new-to-area records) | **poll** weekly |
| Open-Meteo (forecast, marine) | no; `meta.json` tells when a model run lands | **poll** `meta.json` 15 min, fetch data only on a new run |
| NDBC | no | **poll** one bulk file every 10 min, conditional GET |
| NOAA CO-OPS | no | **poll** 6 min |
| IEM HML archive (carp backfill) | no | **poll**: one backfill, then daily |

## As built (leaf E1, 2026-10-01)

What the code does today; the sections below are the audit and design it came from. Where they differ, this section wins.

**Mode per feed.** `sources.mode` is the adapter's own mode (`SourceInfo.mode`), and `/health`, `feeds` and `sources` report it as is: `push`, `poll` or `webhook`. GraphQL `FeedMode` is `PUSH | POLL | WEBHOOK` (the web chips accepted only push and poll before E1; `apps/web/client/hud/topbar/feed-chips.ts` `normalizeFeedState` must accept `webhook` too, or the CRW chip is dropped). A feed is `webhook` only when a provider's change call is its main trigger (CRW); a poller a provider can also wake keeps `poll` and reports `nudge: true` in `sources`.

The last column says why each poll has no push, with the ledger row that holds the search and the provider's docs.

| App | Feed id | Mode | Poll loop | Nudge route | Emitter | Push search (ledger row) and provider docs |
|---|---|---|---|---|---|---|
| carp | `usgs` | poll | 15 min, all sites in one request | no | Rust poller | No push (same search as C1): the OGC API has no subscription endpoint; WaterAlert only emails or texts a person. [OGC API](https://api.waterdata.usgs.gov/docs/ogcapi/) |
| carp | `nwps` | poll | 15 min loop; fetches every wake-up 12:00-18:00Z, hourly otherwise | yes (IEMBot flood products) | Rust poller | No push (same search as C2): the NWPS swagger has no subscription or callback path; IEMBot only nudges it. [NWPS API](https://water.noaa.gov/about/api) |
| carp | `nws-alerts` | poll | 60 s; every poll, empty or not, is a `fetch_runs` row | yes (IEMBot) | Rust poller | No webhook or stream on api.weather.gov (same search as C4); the push for alerts is NWWS-OI (C3), which needs an account. [api docs](https://www.weather.gov/documentation/services-web-api) |
| carp | `nws-forecast` | poll | 60 min; stored only when `updateTime` changes | yes | Rust poller | No push (same search as C6): api.weather.gov has no subscription for gridpoint forecasts. [api docs](https://www.weather.gov/documentation/services-web-api) |
| carp | `iem` | poll | daily (backfill at boot) | yes | Rust poller | No push (same search as C7): IEM offers CSV downloads only. [IEM HML](https://mesonet.agron.iastate.edu/request/hml.php) |
| carp | `nwws` | push | XMPP session (down until `NWWS_USER`/`NWWS_PASS`) | no | Rust XMPP client | Push (C3). [NWWS-OI](https://www.weather.gov/nwws/nwws_oi_request) |
| lionfish | `crw` | webhook | 3 h backstop; data cadence 60 h | yes (ERDDAP) | Rust poller | Webhook nudge (L3): ERDDAP subscription with a URL action. [ERDDAP subscriptions](https://pae-paha.pacioos.hawaii.edu/erddap/subscriptions/index.html) |
| lionfish | `inat` | poll | 10 min (`cadenceMinutes`), conditional GET | no | Rust poller | No push (same search as L1): the subscription paths subscribe a logged-in user to one observation or project. [iNat API](https://api.inaturalist.org/v1/docs/) |
| lionfish | `gbif` | poll | daily | no | Rust poller | No push (same search as L5): the occurrence API has no webhook or callback; a download notice only emails a person. [GBIF API](https://techdocs.gbif.org/en/data-use/api-downloads) |
| lionfish | `nas` | poll | weekly (`cadenceDays`) | no | Rust poller | No push for records (same search as L6): NAS Alerts email and RSS announce a species new to an area, not new records. [NAS API](https://nas.er.usgs.gov/api/v2/) |
| lionfish | `ndbc` | poll | 10 min, one bulk file | no | Rust poller | No push (same search as L7): NDBC publishes files only. [NDBC data](https://www.ndbc.noaa.gov/faq/rt_data_access.shtml) |
| lionfish | `openmeteo-marine` | poll | `meta.json` every 15 min, data on a new run | no | Rust poller | No push or webhook in the docs (same search as L4); `meta.json` gates the data fetch. [marine API](https://open-meteo.com/en/docs/marine-weather-api) |
| lionfish | `goes19-sst` | push | SQS long poll (down until the queue secrets are set) | no | Rust SQS consumer | Push (L9): SNS `NewGOES19Object` to SQS. [NOAA GOES on AWS](https://registry.opendata.aws/noaa-goes/) |
| python | `inat` | poll | 2 min (default `CADENCE`) | no | Rust poller | No push (same search as L1, P1). [iNat API](https://api.inaturalist.org/v1/docs/) |
| python | `gbif`, `nas` | poll | daily | no | Rust poller | No push (same search as L5, L6): GBIF has no webhook; NAS Alerts announce new areas, not records. [GBIF API](https://techdocs.gbif.org/en/data-use/api-downloads), [NAS API](https://nas.er.usgs.gov/api/v2/) |
| python | `nws` | poll | 60 s | no | Rust poller | No webhook or stream on api.weather.gov (same search as C4, P7); the push for alerts is NWWS-OI (P6), which needs an account. [api docs](https://www.weather.gov/documentation/services-web-api) |
| python | `usgs`, `ndbc`, `coops`, `openmeteo` | poll | 15 min, 10 min, 6 min, 60 min | no | Rust poller | No push for any of the four (same search as C1, L7, L8, L4): USGS has no subscription endpoint, NDBC and CO-OPS serve files and REST only, Open-Meteo has no webhook. [USGS OGC API](https://api.waterdata.usgs.gov/docs/ogcapi/), [NDBC](https://www.ndbc.noaa.gov/faq/rt_data_access.shtml), [CO-OPS](https://api.tidesandcurrents.noaa.gov/api/prod/), [Open-Meteo](https://open-meteo.com/en/docs) |
| python | `goes19`, `nwws` | push | SQS, XMPP (down until their secrets are set) | no | Rust consumers | Push (P5, P6): SNS to SQS, and XMPP. [NOAA GOES on AWS](https://registry.opendata.aws/noaa-goes/), [NWWS-OI](https://www.weather.gov/nwws/nwws_oi_request) |

In-process emitters call the pipeline (`scheduler::ingest_payload`) directly; the hook below is the same pipeline over HTTP for an emitter in another process.

**Hook** `POST /v1/{app}/ingest/hook/{source}` (`api/src/ingest/push/hook.rs`). `{source}` is any poll adapter the app runs (there is no `web` source since K1), and the body is the raw provider payload that adapter's `normalize` reads. Headers: `X-Timestamp` (unix s) and `X-Signature` = `hex(HMAC_SHA256(INGEST_HOOK_SECRET, "<ts>.<raw body>"))`; optional `X-Idempotency-Key` (must equal `sha256(body)`, else 400), `X-Source-Url`, `X-Fetched-At` (unix ms). Replay window: a timestamp more than 300 s off is 401. Idempotency: the key is `sha256(body)`; if this app already holds a raw object with that hash for that source and a fetch run for it, or the same bytes are being delivered at that moment, the answer is 200 `{"status":"duplicate","duplicate":true,"idempotencyKey","fetchRunId"}` and nothing is written. Size cap 2 MB (413). 503 without the secret, 404 for a source the app does not run (only after the signature passes), 422 when the body does not normalize (archived and recorded), 202 with the ingest outcome otherwise.

**Nudges** `GET|POST /v1/{app}/ingest/nudge/{source}/{token}` (`api/src/ingest/push/nudge.rs`), for `crw` (lionfish) and `nws-alerts`, `nws-forecast`, `nwps`, `iem` (carp). The token is `INGEST_NUDGE_TOKEN`, compared in constant time (503 when unset, 401 when wrong). Unknown app or a source that takes no nudges: 404. A nudge wakes that source's scheduler task (202 `accepted`); another nudge for the same app and source within 60 s is 200 `duplicate` and wakes nothing. A nudge never cuts a 429/5xx backoff short, and the adapter's own change gate still decides whether anything is stored. The body is ignored (not archived). Nudges are not counted per fetch, so the feed chip does not show which fetch a nudge caused.

**Feed facts** GraphQL `sources` / `sourceInfo(feed)` and evidence `source:<feed>` (`api/src/source_pages.rs` `source_facts`): publisher, API URL, page, licence, attribution, DOI, cadence, expected latency, rate limit, coverage, limits, why it is polled (poll feeds), plus the adapter's mode, data cadence and poll interval, the median fetch-to-commit time over the last 20 runs, the feed-state lag, and the last fetch run and status.

**Alert checks** The review engine reads the alert poller's `fetch_runs` (`forecast::query::alert_check_asof`): "no alert in effect" is a pass only while a successful poll is at most 15 min old, and cites that run (`fetch:<id>`); otherwise the alert check is unknown and the site is `cannot_assess`. `SiteStatus`/`SiteReview` carry `alertsCheckedAt`, `alertsCheckRunId` and `alertsCheckCurrent`.

## Ledger: one row per feed per app

Latency to DB = provider delay (measured) + our worst-case wait. "Searched" is the push search behind each poll row; the full results with URLs are in "Push search, tested live".

| # | App | Feed (source id) | Mechanism | Cadence | Why | Provider docs | Latency to our DB | Licence / rate limit |
|---|---|---|---|---|---|---|---|---|
| C1 | carp | USGS Water Data, OGC `continuous`, stage 00065 + discharge 00060, 8 sites (`usgs`) | poll | 15 min, all sites in one request | 15-min values, core observed stage. No push: OGC API has no subscription endpoint; WaterAlert only emails or texts a person; `cache-control: no-cache, no-store`, no validator (`PUSH usgs-ogc`) | [api.waterdata.usgs.gov/docs/ogcapi](https://api.waterdata.usgs.gov/docs/ogcapi/), [WaterAlert](https://www.usgs.gov/tools/wateralert) | values are 0.3–1.1 h old when served (C1 `AGE`); + ≤ 15 min | Public domain. Anonymous per-IP hourly limit, number unpublished; a free key raises it (`X-RateLimit-Limit: 1000`). Get a key |
| C2 | carp | NOAA NWPS `stageflow`: forecast + observed, flood categories (`nwps`) | poll + nudge | every 15 min 12:00–18:00Z (issuances landed 13:17–15:56Z on 7 of 7 days), hourly otherwise; immediate on an IEMBot flood-product nudge for LCH/LIX/SHV; store a version only when `issuedTime` changes | Forecasts drive "needs review". No push: swagger has no subscription path, responses carry no ETag (`PUSH nwps-swagger subscription=false`) | [water.noaa.gov/about/api](https://water.noaa.gov/about/api), [swagger.json](https://api.water.noaa.gov/nwps/v1/docs/swagger.json) | forecast: `generatedTime` is 8 min after `issuedTime` (15:32 → 15:40Z), so ≤ 23 min in the window; observed: hourly, ~55 min after valid time, + ≤ 60 min | NOAA public data, no published limit; ~2 requests per site per poll |
| C3 | carp | NWWS-OI XMPP, offices LCH, LIX, SHV (`nwws`) | push | continuous; products within seconds | The only true push for NWS alerts (VTEC, flood warnings FLW/FLS). Adapter exists (`push/nwws.rs`, MFL/KEY today); add the three Louisiana offices | [NWWS-OI request](https://www.weather.gov/nwws/nwws_oi_request), [NWWS](https://www.weather.gov/nwws/) | seconds | Free; account by email to NWWS.Issue@noaa.gov, "10 days or more" (`PUSH nwws-oi ten_days=true`). Not in Doppler yet: human step |
| C4 | carp | NWS alerts API `alerts/active?area=LA` (`nws`) | poll (backstop) | 60 s until NWWS-OI is live, then 5 min | Alerts must be right within a minute. No webhook or stream on api.weather.gov; ATOM is a pull format without a hub link. ETag is sent but `If-None-Match` still gets **200** (`PUSH nws-alerts conditional=200`), so each poll is a full fetch | [api docs](https://www.weather.gov/documentation/services-web-api), [NWS CAP](https://vlab.noaa.gov/web/nws-common-alerting-protocol) | ≤ 65 s (60 s + 5 s CDN `max-age`) | Public domain; limit "not public information", generous; `User-Agent` required |
| C5 | carp | IEMBot webhook, rooms lixchat, lchchat, shvchat (`iembot`) | webhook nudge | on each NWS warning product the bot relays | Gives sub-minute alert latency before NWWS-OI is approved. Payload is not trusted: the nudge makes C4 fetch now. Routine RVF/HML river forecasts did not appear in 45 LCH items, so it does not replace C2 polling | [IEMBot project](https://mesonet.agron.iastate.edu/projects/iembot/), [RSS per room](https://weather.im/iembot-rss/room/lchchat.xml) | seconds after IEM parses the product, + one C4 fetch (~1 s) | Free, Iowa State University. Webhook config sits behind Google sign-in (`PUSH iembot-webhook-config status=302`): human step. Payload shape not verified |
| C6 | carp | NWS gridpoint forecast, 3 offices for 8 sites (`nws_fcst`) | poll | 60 min; store a version only when `updateTime` changes | Weather forecast per site: the 12 h periods (temperature, wind, chance of precipitation) and the raw grid (`gridpoints/{office}/{x},{y}`: QPF in mm per 6 h window, gusts), two documents per grid, both versioned on the same `updateTime`. No push (same search as C4). `updateTime` is per office run (all 5 LCH sites share one) | [api docs](https://www.weather.gov/documentation/services-web-api) | forecasts were 0.6–6.5 h old (C1); we add ≤ 60 min | as C4; one call per grid, 3 grids |
| C7 | carp | IEM HML forecast archive (`iem_hml`) | poll (backfill) | once at boot for the replay window, then daily at 18:00Z to fill gaps | NWPS keeps no forecast history; IEM keeps every HML issuance (7 per site in 7 days). No push: IEM offers CSV downloads only | [IEM HML](https://mesonet.agron.iastate.edu/request/hml.php) | not live: backfill | Free, university-run, no published limit. Cache; never re-pull a stored issuance |
| C8 | carp | AISStream.io vessel positions and static data, the Louisiana box (`aisstream`, GE4) | push | continuous websocket; positions stored at most one per vessel per minute, 30 days kept | Ships on the map and the timeline (context, not carp data). A real stream: subscribe once with the key and the box, messages arrive as ships report. Reconnects back off 5 s, 15 s, 60 s, 300 s, then every 15 min; a rejected key stops retries; a 429 waits `Retry-After`; a silent socket is recycled after 5 min | [aisstream.io/documentation](https://aisstream.io/documentation), [message models](https://github.com/aisstream/ais-message-models) | seconds after a shore receiver hears the ship, + up to 10 s batching | Free beta, no formal terms or SLA; AIS is a public radio broadcast (gods-eye-view `DATA_SOURCES.md`: "Free, beta, no formal ToS; AIS is a public broadcast"). Limits: 3 subscribed connections per account, 3 open per IP, 1 subscription update per second; key server side only ("Direct browser connections are not permitted"). Credit shown while the layer is on: "Vessel positions: AISStream.io". Key `AISSTREAM_API_KEY` from aisstream.io: human step |
| L1 | lionfish | iNaturalist observations, genus *Pterois* 47284, 4 area boxes (`inat`) | poll | **10 min** (was 2 min), `If-None-Match` | Recent sightings with photos. Measured: 0–5 updated records per day per box. The API answers with `cache-control: max-age=300`, so polling faster than 5 min mostly reads a cached page. No push: swagger has no hook path; its subscription paths subscribe a logged-in user to one observation or project (`PUSH inat-swagger`) | [api.inaturalist.org/v1/docs](https://api.inaturalist.org/v1/docs/) | upload → index (minutes, not measured) + ≤ 10 min + ≤ 5 min CDN | Per-observation licence (CC0, CC BY, CC BY-NC or all rights reserved): show attribution. "max of 100 requests per minute"; asks ≤ 60/min and < 10,000/day (`PUSH inat-limit`). Conditional GET answers 304 |
| L2 | lionfish | **Dropped in K1 (R14): no taxon enrichment; the species card uses the app config.** iNaturalist taxa (`inat_taxa`) | poll | on a new taxon id, plus weekly refresh | Species card text and photo. Same search as L1 | [api.inaturalist.org/v1/docs](https://api.inaturalist.org/v1/docs/) | minutes after the first sighting of a taxon | Shares L1's 10,000/day budget; Wikipedia text CC BY-SA |
| L3 | lionfish | NOAA Coral Reef Watch `dhw_5km` on PacIOOS ERDDAP (`crw`) | webhook nudge + poll backstop | nudge on dataset change (one new day, last change 2026-09-30T18:50:23Z); backstop `time[(last)]` check every 3 h | Reef heat stress (SST, anomaly, DHW, BAA). ERDDAP has a subscription system that "can send you an email or contact a URL that you specify" when a dataset changes (`PUSH crw-erddap-subscribe url_action=true`). ERDDAP calls our URL; it cannot sign, so it is a nudge | [ERDDAP subscriptions](https://pae-paha.pacioos.hawaii.edu/erddap/subscriptions/index.html), [dataset RSS](https://pae-paha.pacioos.hawaii.edu/erddap/rss/dhw_5km.rss), [CRW 5 km](https://coralreefwatch.noaa.gov/product/5km/) | data are ~31 h old when published (day T 12Z lands T+1 18:50Z); + minutes with the nudge, ≤ 3 h without | Free "without restriction"; credit NOAA CRW and cite the DOI. No published limit; one request per area per change. Subscription needs an email validation click: human step |
| L4 | lionfish | Open-Meteo Marine: waves, currents (`openmeteo_marine`) | poll, gated | check `meta.json` every 15 min; fetch data only when `last_run_availability_time` changes | Dive and fieldwork windows. Marine models run every 6 h (GFS-Wave, ECMWF WAM), 12 h (MF wave) or 24 h (MF currents) (`PUSH openmeteo-meta`), so the old hourly fetch re-read the same run 5 to 23 times. No push or webhook in the docs | [marine API](https://open-meteo.com/en/docs/marine-weather-api), [model updates](https://open-meteo.com/en/docs/model-updates) | ≤ 15 min after a run becomes available | CC BY 4.0, free tier non-commercial and < 10,000 calls/day; commercial use needs a paid key |
| L5 | lionfish | GBIF occurrence search, genus key 2334432, 4 boxes (`gbif`) | poll | daily, `modified` window | History and the iNat-duplicate case. Not frequent: GBIF re-ingests iNat weekly. No push: occurrence OpenAPI has no webhook or callback; `notificationAddresses` emails a person when a download is ready (`PUSH gbif-openapi`) | [GBIF API downloads](https://techdocs.gbif.org/en/data-use/api-downloads), [OpenAPI](https://techdocs.gbif.org/openapi/occurrence.json) | days to weeks (index lag) + ≤ 24 h | Per-dataset CC0 / CC BY / CC BY-NC; cite datasets. No published hard limit; `cache-control: max-age=600`, no validator |
| L6 | lionfish | USGS NAS, genus *Pterois*, global pull filtered to boxes (`nas`) | poll | **weekly** (was daily) | Curated records lag weeks to months; newest Florida record 2026-05-14. No push for records: NAS Alerts email and RSS announce a species new to an area (9 national items from 2026-07-21 to 2026-09-08, `PUSH nas-alerts-rss`), not new records | [NAS API](https://nas.er.usgs.gov/api/v2/), [NAS Alerts](https://nas.er.usgs.gov/AlertSystem/default.aspx) | weeks + ≤ 7 d | Public domain; no published limit; a 5000-row page takes ~26 s, so walk pages in sequence |
| L7 | lionfish | NDBC `latest_obs.txt`, WTMP of buoys in the 4 boxes (`ndbc`) | poll | 10 min, `If-None-Match` | In-situ SST for the satellite-vs-buoy conflict (Florida, plus 42058 near Colombia). One file covers 891 stations and refreshes every 10 min (Last-Modified 05:15:24 → 05:25:23Z); answers 304 when unchanged (`PUSH ndbc-latest-obs`). Replaces one request per station. No push on NDBC | [NDBC data](https://www.ndbc.noaa.gov/faq/rt_data_access.shtml) | obs at 04:50Z appeared at 05:15Z: ~25 min, + ≤ 10 min | Public domain; no published limit |
| L8 | lionfish | **Dropped in K1 (R14): lionfish registers no `coops`.** NOAA CO-OPS water temperature, Florida stations (`coops`) | poll | 6 min | 6-minute in-situ water temperature, Florida only. No push, no validator, `no-store` (`PUSH coops`) | [CO-OPS API](https://api.tidesandcurrents.noaa.gov/api/prod/) | 6–10 min (`lag_min=10`) + ≤ 6 min | Public domain; no published limit; one station per request |
| L9 | lionfish | GOES-19 `ABI-L2-SSTF` full disk (`goes19`) | push | hourly file, SNS → SQS, 20 s long poll | Satellite SST over all 4 areas (no CONUS SST sector exists). SNS "only Lambda and SQS protocols allowed" (`PUSH goes19-sns`) | [registry.opendata.aws/noaa-goes](https://registry.opendata.aws/noaa-goes/) | file lands 2.8 min after scan end (~62 min after scan start); + ≤ 20 s + decode | NOAA open data, no limit. Needs an AWS account with one SQS queue: human step. SQS free tier covers a 20 s long poll (~130k receives/month) |
| L10 | lionfish | AISStream.io vessel positions, the four area boxes in one subscription (`aisstream`, GE4) | push | as C8 (one connection for lionfish, one for carp: 2 of the account's 3) | Ships near the reefs as context. Same stream as C8 | [aisstream.io/documentation](https://aisstream.io/documentation) | as C8; terrestrial receivers only, so coverage is thin off Belize and Colombia | as C8 |
| P1 | python | iNaturalist observations, *Python bivittatus* 238252, Everglades box (`inat`) | poll | **10 min**, `If-None-Match` | Live sightings. Measured: 4 updated in 24 h, 8 in 7 days. Same push search and CDN reason as L1 | [api.inaturalist.org/v1/docs](https://api.inaturalist.org/v1/docs/) | as L1 | as L1 |
| P2 | python | **Dropped in K1 (R14), as L2.** iNaturalist taxa (`inat_taxa`) | poll | on a new taxon, weekly refresh | Species card. Same as L2 | [api.inaturalist.org/v1/docs](https://api.inaturalist.org/v1/docs/) | as L2 | as L2 |
| P3 | python | GBIF, taxon key 4820533, box (`gbif`) | poll | daily | History, iNat duplicates. Same as L5 | [GBIF API downloads](https://techdocs.gbif.org/en/data-use/api-downloads) | as L5 | as L5 |
| P4 | python | USGS NAS, genus *Python*, `state=FL` + box (`nas`) | poll | weekly | Curated records. Same as L6 | [NAS API](https://nas.er.usgs.gov/api/v2/) | as L6 | as L6 |
| P5 | python | GOES-19 `ABI-L2-LSTC` (hourly), `ACMC` (5 min), `FDCC` (5 min), `SSTF` (hourly) (`goes19`) | push | per file, SNS → SQS | Land skin temperature (activity), cloud mask (marks LST cells cloudy instead of dropping them), fire (burns), SST conflict case. Measured 1.8 min (LSTC), 0.6 min (ACMC), 0.2 min (FDCC) from scan end to file | [registry.opendata.aws/noaa-goes](https://registry.opendata.aws/noaa-goes/) | 1–4 min after scan end | as L9; same queue, one filter |
| P6 | python | NWWS-OI, offices MFL and KEY (`nwws`) | push | continuous | Freeze, cold, heat and flood alerts: cold snaps kill pythons. Adapter exists | [NWWS-OI request](https://www.weather.gov/nwws/nwws_oi_request) | seconds | as C3 |
| P7 | python | NWS alerts API, Florida + marine zones (`nws`) | poll (backstop) | 60 s until NWWS-OI is live, then 5 min | Same as C4. Conditional GET on `area=FL` also answered 200 to its own ETag | [api docs](https://www.weather.gov/documentation/services-web-api) | ≤ 65 s | as C4 |
| P8 | python | IEMBot webhook, rooms mflchat and keychat (`iembot`) | webhook nudge | per relayed product | Same as C5 | [IEMBot](https://mesonet.agron.iastate.edu/projects/iembot/) | seconds + one P7 fetch | as C5 |
| P9 | python | NDBC `latest_obs.txt`, region stations (`ndbc`) | poll | 10 min, conditional GET | Buoy and C-MAN sea and water temperature, wind. Same as L7; the current adapter makes ~52 ranged requests per poll, one per station | [NDBC data](https://www.ndbc.noaa.gov/faq/rt_data_access.shtml) | as L7 | as L7 |
| P10 | python | NOAA CO-OPS water level + temperature (`coops`) | poll | 6 min | 6-minute tide level and water temperature. Same as L8 | [CO-OPS API](https://api.tidesandcurrents.noaa.gov/api/prod/) | as L8 | as L8 |
| P11 | python | USGS Water, Everglades stage and water temperature (`usgs`) | poll | 15 min | Water level concentrates prey and snakes. Same search as C1. The adapter calls legacy `waterservices.usgs.gov`, which USGS decommissions in winter 2027 with planned degradations before then; move it to the OGC API that carp uses | [migration guide](https://api.waterdata.usgs.gov/docs/ogcapi/migration/), [WDFN updates 2026](https://waterdata.usgs.gov/blog/api-updates-2026/) | as C1 | as C1 |
| P12 | python | Open-Meteo forecast: air temperature, rain, wind (`openmeteo`) | poll, gated | check `meta.json` every 15 min; fetch when the HRRR run (hourly) or GFS run (6 h) changes | Activity and field conditions. HRRR lands ~1 h 39 min after its init time, hourly (`PUSH openmeteo-meta`) | [forecast API](https://open-meteo.com/en/docs) | ≤ 15 min after a run lands | as L4 (shares the 10,000/day budget) |
| P13 | python | Open-Meteo Marine: waves, SST (`openmeteo_marine`) | poll, gated | as L4 | Coastal field conditions | [marine API](https://open-meteo.com/en/docs/marine-weather-api) | as L4 | as L4 |

**Kept source → app map**

- carp only: `nwps` (C2), `nws-forecast` (C6), `iem` (C7), `nws-alerts` (C4: the `nws.rs` poller with `area=LA`, matched to sites)
- carp + python: `usgs` (C1, P11; both on the OGC API since leaf C4, python by region bbox, carp by site list), `nwws` (C3, P6), `nws` (P7; python only by that id), `iembot` (C5, P8)

Source ids as built (leaf C4, `api/src/app/config.rs` `SOURCES`): `nws_fcst` → `nws-forecast`, `iem_hml` → `iem`; the carp alerts poller registers as `nws-alerts` so its fetch runs, cursor and feed chip never mix with python's `nws`. Fixtures: `api/fixtures/{usgs_ogc,nwps,nws_la/{alerts,forecast},iem}`.
- lionfish only: `crw` (L3)
- lionfish + python: `inat` and `inat_taxa` (L1, L2, P1, P2), `openmeteo_marine` (L4, P13), `gbif` (L5, P3), `nas` (L6, P4), `ndbc` (L7, P9), `coops` (L8, P10), `goes19` (L9 SSTF; P5 LSTC, ACMC, FDCC, SSTF)
- python only: `openmeteo` (P12)

Optional carp additions from `docs/APPS.md` (iNat carp sightings, Open-Meteo, GOES) are not in the ledger; they get rows here when the carp core works.

## Push search, tested live

Each claim below was tested by `scripts/probe-push.ts` or the curl call shown, 2026-10-01 05:20–05:28Z.

| Claim | Request | Response | Verdict |
|---|---|---|---|
| NWS API conditional GET does not save a fetch | `GET https://api.weather.gov/alerts/active?area=LA`, then the same with `If-None-Match: <its ETag>` | first 200 with ETag `W/"596a…:dtagent…"`; second **200**, not 304. Same for `area=FL` | Each 60 s poll is a full fetch. The `nws.rs` validator code costs nothing but gives nothing |
| api.weather.gov ATOM is not a push channel | `GET https://api.weather.gov/alerts/active.atom?area=FL` | 200 `application/atom+xml`, no `rel="hub"` (WebSub) link | Pull only |
| NWWS-OI needs an emailed application | `GET https://www.weather.gov/nwws/nwws_oi_request` | 200; page text matches "10 days" | Push exists; human step to get credentials |
| IEMBot relays NWS products and offers webhooks | `GET https://weather.im/iembot-rss/room/lchchat.xml`; `GET https://weather.im/iembot/config/` | lchchat RSS 200 with 45 items (shvchat newest 2026-10-01 05:20Z); config 302 to Google sign-in | Webhook push exists, configured by a signed-in person; adopt as nudge |
| iNaturalist has no webhook | `GET https://api.inaturalist.org/v1/swagger.json` | 0 hook paths; 4 subscription paths, all per observation or project, for a logged-in user | Poll |
| iNaturalist conditional GET works | `GET /v1/observations?taxon_id=238252&place_id=21…` then `If-None-Match` | 200 then **304**; `cache-control: public, max-age=300` | Poll at 10 min with the ETag |
| GBIF has no webhook | `GET https://techdocs.gbif.org/openapi/occurrence.json` | `webhook=false callback=false`; `notificationAddresses` present (email) | Poll daily |
| NAS has alerts, not a record feed | `GET https://nas.er.usgs.gov/AlertSystem/RSS.aspx` | 200, 9 items, 2026-07-21 to 2026-09-08, national | Poll weekly |
| USGS Water OGC API has no validator | `GET …/collections/continuous/items?monitoring_location_id=USGS-07381490…` | 200 `cache-control: no-cache, no-store, must-revalidate`, no ETag | Poll 15 min, batched |
| NWPS has no subscription | `GET https://api.water.noaa.gov/nwps/v1/docs/swagger.json` | no `subscri`, `webhook` or `callback` text; stageflow has no ETag | Poll; issuance window cadence |
| ERDDAP can call our URL on CRW change | `GET https://pae-paha.pacioos.hawaii.edu/erddap/subscriptions/add.html` | 200; form field `action` (URL); "send you an email with a link to validate" | Webhook nudge, after one validation click |
| CRW changes once a day | `GET …/erddap/rss/dhw_5km.rss`; `GET …/griddap/dhw_5km.csv?time[(last)]` | changed 2026-09-30T18:50:23Z; newest step 2026-09-29T12:00Z (41.5 h old at probe time) | Daily; 3 h backstop is ample |
| Open-Meteo publishes run availability | `GET https://marine-api.open-meteo.com/data/ncep_gfswave025/static/meta.json` | run 2026-10-01T00:00Z available 05:25:18Z, `update_interval_seconds` 21600 | Gate data fetches on it |
| NDBC bulk file supports 304 | `GET https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt` then `If-None-Match` | 200 (891 stations) then **304** | One request per 10 min instead of ~52 |
| GOES-19 SNS only reaches SQS or Lambda | `GET https://registry.opendata.aws/noaa-goes/` | "only Lambda and SQS protocols allowed"; topic `arn:aws:sns:us-east-1:123901341784:NewGOES19Object` | Push via our own SQS queue |
| Other NOAA push on AWS | `GET https://registry.opendata.aws/{noaa-ndbc-pds, noaa-coastwatch-crw, noaa-ghrsst-pds}` (guessed slugs) plus a registry web search | 404 each; the search found NODD SNS topics for GOES, NBM and OFS only | None for NDBC, CRW or CO-OPS |

## Emitter design

One delivery path for every feed. Push adapters (SQS, XMPP) and pollers both end in the same signed POST, so archive, normalize, dedupe and feed state behave the same whatever the source.

### Where emitters run

The Rust scheduler (`api/src/ingest/scheduler.rs`), one supervised task per (app, source), paced by the existing rate governor. Each app has its own scheduler (C-A1), so `inat` for lionfish and `inat` for python are separate tasks with separate cursors, sharing one `inat` governor per host so the 60/min budget holds across apps.

Cloudflare Worker cron was considered and rejected for this: the free plan allows 5 cron triggers per account and 10 ms CPU per run ([limits](https://developers.cloudflare.com/workers/platform/limits/)); we have 17 sources across 3 apps, GOES needs a NetCDF decode, and NWWS needs a long-lived XMPP session. A Worker emitter would only fit small JSON polls and would add a second deploy target for them.

| Emitter | Runs in | Feeds |
|---|---|---|
| SQS long-poll consumer | Rust task | `goes19` (lionfish SSTF; python LSTC, ACMC, FDCC, SSTF) |
| XMPP client | Rust task | `nwws` (carp LCH/LIX/SHV; python MFL/KEY) |
| Poller | Rust task | `usgs`, `nwps`, `nws`, `nws_fcst`, `iem_hml`, `inat`, `inat_taxa`, `crw`, `openmeteo`, `openmeteo_marine`, `gbif`, `nas`, `ndbc`, `coops` |
| Nudge receiver | Axum route | `iembot` → wakes `nws` (and `nwps` on flood products); ERDDAP → wakes `crw` |

### Steps per payload

1. **Fetch** under the governor (minimum interval; on 429 or 5xx double up to a cap, honour `Retry-After`). Send `If-None-Match` / `If-Modified-Since` where the provider answers 304 (iNat, NDBC). A 304 or an unchanged gate (`issuedTime`, `updateTime`, Open-Meteo run time, CRW `time[(last)]`) records a `fetch_run` with status `empty` and stops.
2. **Archive** the raw bytes first: gzip, put to R2 at `raw/{app}/{source}/{yyyy}/{mm}/{dd}/{sha256}`, so a payload exists even if delivery fails.
3. **Deliver**: `POST /v1/{app}/ingest/hook/{source}` with the raw provider body (not normalized rows) and headers:
   - `X-Timestamp`: unix seconds; rejected when more than 300 s off;
   - `X-Signature`: `hex(HMAC_SHA256(INGEST_HOOK_SECRET, "<ts>.<body>"))`, as `push/hook.rs` does now;
   - `X-Idempotency-Key`: `sha256(body)` hex;
   - `X-Source-Url`, `X-Fetched-At` (unix ms), `Content-Type`, `X-Raw-Key` (the R2 key from step 2);
   - `X-Cursor` (optional): the cursor to commit with this payload (iNat `updated_since`, GBIF poll day);
   - `X-Ack` (optional): SQS receipt handle, deleted only after the write commits.
4. **Receive**: the hook verifies the signature, looks up `{source}` in the app's registry and runs that adapter's pure `normalize(&[u8])`. Rows go to the app's writer thread in one transaction with the `fetch_run`, cursor and `raw_objects` row. Then the affected frames are marked dirty.

Same process today, so the POST goes to loopback. Keeping it HTTP means a future out-of-process emitter (another host, a Worker) needs no server change.

### Retry

- Emitter → hook: 5xx, timeout or connection error is retried at 1, 2, 4, 8, 16 s, then every 5 min, up to 1 h. 401, 404, 413 and 422 are not retried; 422 still archives and records the run, as now.
- If delivery gives up, the payload stays in R2 under `raw/{app}/{source}/…` with a `fetch_run` status `error` ("undelivered"). On boot the emitter replays undelivered keys from the last 24 h in order before fetching.
- SQS: the message is deleted only after the hook's write commits (existing rule). Otherwise it reappears after the visibility timeout, and the idempotency key absorbs the repeat.
- NWWS-OI: on reconnect the room is re-joined with history back to the last product seen (existing rule, capped at 1 h).

### Dedupe

- **Payload level:** `X-Idempotency-Key` = sha256 of the body, unique per (app, source) in `raw_objects`. A repeat answers 200 `{"duplicate": true}` and writes nothing. The scheduler already reuses an archived object with the same sha256; this makes it a unique index, not a lookup.
- **Row level:** upsert on `(source_id, ext_id)` for sightings; readings on `(station, param, observed_at, origin)`; NWPS forecasts on `(lid, issuedTime)` with one row per valid time; NWS gridpoint forecasts on `(grid, updateTime)`; alerts on the VTEC key, which `nws.rs` and `nwws.rs` both derive, so the push and the poll copy of one alert land on one row.
- **Cross-source:** GBIF records from the iNat dataset link to the iNat sighting by `catalogNumber` (`canonical_id`), never counted twice.

### Nudges

Third-party webhooks cannot sign with our secret. They call `GET or POST /v1/{app}/ingest/nudge/{source}/{token}`, where `token` is a per-source random secret in the URL we registered with the provider.

- The body is ignored (as built: not archived).
- The route wakes the target source's task at once, at most once per 60 s per app and source (a repeat answers 200 `duplicate`), and answers 202.
- Data still arrives only through the emitter's own fetch from the provider, so a forged nudge can cost one extra request and nothing else.
- Not built: per-fetch nudge attribution. The feed chip shows the adapter's mode (`webhook` for CRW), not whether the newest fetch came from a nudge.

### Freshness reported to the UI

- `sources` holds mode (`push` | `poll` | `webhook`), cadence and `max_latency` per row of the ledger. `feed_state.rs` classifies each source as nominal, lagging, stale or down from newest `observed_at`, last `fetch_run` and errors, and appends the governor's backoff state.
- Push sources have no fetch clock, so a quiet channel is told apart from a dead one. GOES uses its most frequent product as the heartbeat: for python ACMC (one file every 5 min), so no SQS message for 15 min makes `goes19` lagging; for lionfish SSTF (hourly), so 90 min. NWWS uses its XMPP keepalive: a dropped session marks `nwws` down while `nws` polls at 60 s.
- Sources without credentials (`goes19` without SQS, `nwws` without an account, the two nudges before sign-up) are registered and shown as down with the reason, not hidden (existing `push::disabled`).
- Provider lag is stated separately from our lag: the evidence drawer shows `observed_at`, the forecast `issuedTime` where one exists, and `received_at` for each value.

### Websocket fan-out per app

Clients connect to `/v1/{app}/graphql` over WebSocket (C-A2). Each app has its own `Hub`, so events never cross apps.

| Subscription | Carries | carp | lionfish | python |
|---|---|---|---|---|
| `feeds` | a snapshot, then one `FeedState` per source whose state, last fetch or newest value changed (published every 15 s) | 7 sources | 9 sources | 13 sources |
| `framesUpdated { from to }` | the time range whose frames were rebuilt after a write (5 s debounce); clients refetch only that range | readings, forecast versions and alerts timeline (no hotspot grid) | sightings, reef stress, buoy and satellite SST frames | sightings, LST, alerts frames |
| `ops(boardId, afterSeq)` | team ops (missions, notes, messages) on board `<app>:main`, backlog then live | yes | yes | yes |

## Dropped feeds and removal notes for K1

Each item serves none of the three apps. K1 (R14) has removed them from `api/src`, `apps/web/**`, `spec/apps` and the fixtures: every note below is done. The rows stay as the record of what went and why.

| Item | Where it was | Why dropped | K1 note |
|---|---|---|---|
| iNat `introduced=true` background query | `api/src/ingest/poll/inat.rs` (`introduced` cursor, second query) | No app shows non-focus introduced species (R14 removes "other" taxa) | Done: query and its cursor field removed |
| The two other land taxa (ids 2 and 3) | `inat.rs`, `gbif.rs`, `nas.rs` genera, `poll/bio.rs` `Focus` variants, migration seed | Not one of the three apps | Done: ids, enum variants, NAS genera, fixtures and web/agent literals removed; migration 0011 deletes seeded taxa 2 and 3, and each app purges rows of taxa outside its config at boot |
| `web` hook source | `api/src/ingest/push/hook.rs` (`HookSource::web`) | It was for Firecrawl monitors (a stretch goal never built); no feed posts to it | Done: `web` removed from the hook and from the carp and python configs; the route stays, per app, for the app's own poll adapters |
| Firecrawl monitors of FWC pages | `docs/research.md` §7 only | Stretch goal, no app needs it | Done: struck from the docs; nothing in code |
| aisstream.io | `docs/research.md` §7 only | Weak fit, skipped | Done: struck from the docs; nothing in code |
| NASA FIRMS | `docs/research.md` §2 only | GOES-19 FDCC (push, 5 min) covers fire for python | Done: struck from the docs; nothing in code |
| NWS for lionfish | `docs/LIONFISH_WATCH.md` | US-only, no lionfish value | Done: `spec/apps/lionfish.json` registers no `nws`/`nwws` |
| CO-OPS water level for lionfish | `coops.rs` | Lionfish needs water temperature only | Done: lionfish registers no `coops` |
| Open-Meteo forecast (air, rain, wind) for lionfish | `openmeteo.rs` | Lionfish uses marine variables only | Done: lionfish registers only `openmeteo-marine` |
| GOES LSTC, ACMC, FDCC for lionfish | `goes_sqs.rs` `wanted()` | Lionfish uses SST only | Done: per-app product filter from config; lionfish `goes19-sst` asks for `ABI-L2-SSTF` only |

Replaced, not dropped (owner is the feed's task, not K1):

| Item | Where | Replacement |
|---|---|---|
| Legacy USGS WaterServices IV endpoint | `usgs.rs` (`waterservices.usgs.gov`) | OGC `continuous` collection, as carp; legacy is decommissioned in winter 2027 |
| NDBC one request per station | `ndbc.rs` (`realtime2/<ID>.txt`) | `latest_obs/latest_obs.txt` for live; `realtime2` for backfill only |
| iNat 2 min cadence | `inat.rs` `CADENCE` | 10 min (CDN `max-age=300`, 0–5 updates per day per box) |
| NAS daily cadence | `nas.rs` `CADENCE` | weekly |
| Open-Meteo hourly fetch | `openmeteo.rs` | `meta.json` gate, 15 min check |
| Hook route `/v1/ingest/hook/{source}` taking normalized rows | `push/hook.rs` | `/v1/{app}/ingest/hook/{source}` taking raw provider bodies, plus `/v1/{app}/ingest/nudge/{source}/{token}` |

## Human steps

All are sign-ups or validation clicks that need a person. None blocks the polls.

1. Email NWWS.Issue@noaa.gov for an NWWS-OI account (10+ days), then set `NWWS_USER` / `NWWS_PASS`.
2. Create an AWS account, an SQS queue subscribed to `NewGOES19Object` with a key-prefix filter for the four products, then set `GOES_SQS_URL` and the key pair.
3. Sign in at weather.im/iembot/config and add webhooks for lixchat, lchchat, shvchat, mflchat, keychat pointing at the nudge URLs.
4. Subscribe `dhw_5km` on PacIOOS ERDDAP with the nudge URL as the action, and click the validation email.
5. Request a free USGS Water Data API key.
6. Set `INGEST_HOOK_SECRET` (Doppler `inversa/dev` holds only `OPENROUTER_API_KEY` today).
