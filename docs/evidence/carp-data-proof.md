# C1 data proof: Louisiana river sites for the carp app

Run: `bun scripts/probe-carp.ts` at 2026-10-01T05:05:35Z (run 1) and 2026-10-01T05:16:14Z (run 2). Live public APIs, no keys (Doppler `inversa/dev` holds no USGS or NWS key). Numbers below come from run 1 unless marked; re-run the script to refresh.

The probe prints the gate lines `SITE`, `OBS`, `FCST`, `NWS` and four evidence lines: `DATUM` (USGS vs NWPS stage at the same timestamp), `THRESH` (flood categories), `AGE` (hours since each feed's newest value), `ARCHIVE` (past forecast issuances from IEM), and one `ALERTS` summary.

## Sites

Eight sites, all with a USGS gauge, an NWPS forecast point, and an NWS grid. Four are in the Atchafalaya Basin because L'CARP "is currently only active in the Atchafalaya Basin" (see G6). The other four cover the rivers named in the brief. Labelled "demonstration locations" until Inversa supplies operating areas.

| id (NWPS lid) | name | lat, lon | USGS site | NWS office/grid | stage | discharge | NWPS forecast | flood categories |
|---|---|---|---|---|---|---|---|---|
| SMML1 | Atchafalaya River at Simmesport | 30.9825, -91.7983 | 07381490 | LCH/113,129 | yes | yes | yes | yes |
| KRZL1 | Atchafalaya River at Krotz Springs | 30.5689, -91.7614 | 07381500 | LCH/115,111 | yes | **no** | yes | yes |
| BLRL1 | Atchafalaya River above Butte La Rose | 30.2814, -91.6867 | 07381515 | LCH/118,98 | yes | **no** | yes | yes |
| MCGL1 | Atchafalaya River at Morgan City | 29.6964, -91.2108 | 07381600 | LCH/137,73 | yes | yes | yes | yes |
| BTRL1 | Mississippi River at Baton Rouge | 30.4292, -91.2069 | 07374000 | LIX/24,108 | yes | yes | yes | yes |
| AEXL1 | Red River at Alexandria | 31.3089, -92.4392 | 07355500 | LCH/88,143 | yes | **no** | yes | yes |
| MLUL1 | Ouachita River at Monroe | 32.5003, -92.1197 | 07367005 | SHV/134,68 | yes | yes | yes | yes |
| BXAL1 | Pearl River near Bogalusa | 30.7931, -89.8208 | 02489500 | LIX/76,126 | yes | yes | yes | yes |

8 of 8 have all three feeds and a current forecast (`fcst_ok=yes` means issued in the last 36 h). Coordinates are the NWPS gauge location.

**Id mapping.** NWPS has a `usgsId` field, but it is empty for 4 of the 8 (KRZL1, MCGL1, BTRL1, AEXL1). The mapping lid → USGS site is ours: the USGS gauge with stage data within 0.06° of the NWPS point, then checked by comparing stage at the same timestamp (`DATUM`):

| id | NWPS `usgsId` | USGS − NWPS stage (ft) | same datum? |
|---|---|---|---|
| SMML1 | 07381490 | 0.00 | yes |
| KRZL1 | empty | **−2.45** (1.47 vs 3.92) | **no** |
| BLRL1 | 07381515 | 0.00 | yes |
| MCGL1 | empty | 0.20 (0.28 at 02:00Z in an interim run) | close: different physical gauge, tidal |
| BTRL1 | empty | 0.23 | close: different physical gauge |
| AEXL1 | empty | 0.00 | yes |
| MLUL1 | 07367005 | 0.00 | yes |
| BXAL1 | 02489500 | 0.00 | yes |

Rule for the build: flood categories are defined on the **NWPS** stage, so the category is computed from NWPS observed/forecast stage, never from USGS stage. USGS stage is used for history and change (24 h change is offset-free). At KRZL1 the USGS reading must never be compared to the thresholds: it would show 1.47 ft against an action stage of 28 ft that applies to a gauge reading 3.92 ft.

## Observations (USGS, last 7 days)

Endpoint: OGC API `continuous` collection, one request for all 8 sites and both parameters (`monitoring_location_id=USGS-a,USGS-b,…&parameter_code=00065,00060&time=P7D`). `usgs_requests=1` per run.

| id | readings 7 d | newest (UTC) | stage ft | discharge cfs | 24 h change ft |
|---|---|---|---|---|---|
| SMML1 | 670 | 2026-10-01T04:30Z | 7.87 | 118000 | +0.49 |
| KRZL1 | 668 | 04:00Z | 1.47 | none | +0.27 |
| BLRL1 | 668 | 04:00Z | 4.09 | none | +0.11 |
| MCGL1 | 668 | 04:00Z | 3.57 | 26900 | +0.01 |
| BTRL1 | 669 | 04:15Z | 8.15 | 245000 | +0.89 |
| AEXL1 | 671 | 04:45Z | 19.98 | none | −0.01 |
| MLUL1 | 668 | 04:00Z | 18.21 | 1430 | −0.09 |
| BXAL1 | 669 | 04:15Z | 6.11 | 1630 | −0.02 |

All 8 newest readings are 0.3–1.1 h old (`AGE usgs_stage_h`). 15-minute data, ~96 readings a day.

- Times come back as `+00:00`; the probe normalises to `Z`. NWPS gauges declare `timeZone=CST6CDT`, NWS forecast periods carry a local offset (`-05:00` in CDT). Store UTC, render Central.
- Units: USGS discharge is **cfs**; NWPS flow is **kcfs**. Convert before comparing.
- `-999999` and null values are dropped (USGS "no value").
- MCGL1 is tidal: discharge went from 26900 cfs (04:00Z) to 22300 cfs (05:00Z). Show a 24 h mean there, not the instantaneous value.

**Discharge disagreement at Monroe.** NWPS reports 8.18 kcfs (8180 cfs) at MLUL1 while USGS 07367005 reports 1430 cfs at the same hour and the same stage (18.21 ft). A factor of 5.7. In run 2 the USGS 05:00Z value was 1170 cfs (factor 7.0), so the USGS series also swings hour to hour, likely lock operations at Columbia upstream (unconfirmed). The NWPS flow is probably a rating-curve conversion; the USGS value may be index-velocity. Not resolved here. The UI must label flow with its source and never mix the two.

## Forecasts (NWPS)

Endpoint: `https://api.water.noaa.gov/nwps/v1/gauges/{lid}/stageflow` (observed + forecast in one call) and `/gauges/{lid}` (metadata, flood categories).

| id | issued (UTC) | valid from → to | points | peak ft | category of peak |
|---|---|---|---|---|---|
| SMML1 | 2026-09-30T15:32Z | 09-30 18Z → 10-14 12Z | 56 | 13.7 | none |
| KRZL1 | 2026-09-30T15:32Z | 09-30 18Z → 10-14 12Z | 56 | 9.0 | none |
| BLRL1 | 2026-09-30T15:32Z | 09-30 18Z → 10-14 12Z | 56 | 7.8 | none |
| MCGL1 | 2026-09-30T15:32Z | 09-30 18Z → 10-14 12Z | 56 | 4.0 | **action** |
| BTRL1 | 2026-09-30T14:58Z | 09-30 18Z → 10-15 00Z | 58 | 15.1 | none |
| AEXL1 | 2026-09-30T14:16Z | 09-30 18Z → 10-05 12Z | 20 | 20.1 | none |
| MLUL1 | 2026-09-30T14:19Z | 09-30 18Z → 10-05 12Z | 20 | 18.3 | none |
| BXAL1 | 2026-09-30T13:17Z | 09-30 18Z → 10-10 12Z | 40 | 6.1 | none |

- Forecast steps are 6-hourly. Horizon differs per site: 5 days (Red, Ouachita), 10 days (Pearl), 14–15 days (Atchafalaya, Mississippi).
- MCGL1's peak of 4.0 ft equals its action stage (4 ft), so it reads "action" ("at or above"). NWPS's own `status.forecast.floodCategory` also says `action`. Morgan City's action stage is low and tidal, so it will flag often; the score should weight the category by how long the forecast stays above it.
- MLUL1 status is `low_threshold` (below the low-water threshold), which the gate's enum maps to `none`. Low water is itself an operations signal (access, ramps) and is worth keeping as a separate flag.
- Rising signal worth a demo: BTRL1 forecast to rise from 8.15 to 15.1 ft and SMML1 from 7.87 to 13.7 ft over two weeks, still far below action stage.

**Issuance cadence: once a day, mid-morning Central.**

- Run 1 (05:05Z) and run 2 (05:16:14Z, 10 min 39 s later) returned the same `issuedTime` for every site (SMML1/KRZL1/BLRL1/MCGL1 2026-09-30T15:32Z, BTRL1 14:58Z, AEXL1 14:16Z, MLUL1 14:19Z, BXAL1 13:17Z), i.e. no new issuance in between.
- The IEM archive (below) shows exactly 7 issuances per site in the last 7 days, one per day, between 13:17Z and 15:56Z (08:17–10:56 CDT). In flood, RFCs may issue more often; the poller should not assume one a day.
- So poll NWPS forecasts every 30–60 minutes and store a new version only when `issuedTime` changes. NWPS observed values are hourly and appear about 55 minutes after their valid time (`generatedTime` vs `validTime`).

**Historical forecast archive.**

- NWPS: **none**. The API page says "This service does not contain historical data other than crest and low water history" ([water.noaa.gov/about/api](https://water.noaa.gov/about/api)). The OpenAPI spec ([swagger.json](https://api.water.noaa.gov/nwps/v1/docs/swagger.json)) has no time or issuance parameter on any `stageflow` path. Tested: `/gauges/SMML1/stageflow/forecast?issuedTime=2026-09-27T15:56:00Z` and `?asOf=2026-09-27` both return the current 2026-09-30T15:32Z forecast, so the parameters are ignored.
- **Third-party archive exists:** the Iowa Environmental Mesonet stores every NWS HML forecast product. `https://mesonet.agron.iastate.edu/cgi-bin/request/hml.py?station=SMML1&sts=…&ets=…&kind=forecasts&fmt=csv` returned the 2026-09-27T15:56Z SMML1 forecast (6.9 ft at 2026-09-27 18Z, 106 kcfs, …). The probe's `ARCHIVE` lines show 7 issuances in 7 days for all 8 sites. This means the "what did we know yesterday afternoon" replay can be **backfilled** from IEM, not only from our own snapshots taken from day one. IEM is a university service (Iowa State), not NOAA; cite it as such and cache, do not hammer it. How far back it goes per station was not measured.

## NWS (api.weather.gov)

Per site: `/points/{lat},{lon}` → grid, then the grid `forecast` and `/alerts/active?point=lat,lon`.

| id | grid | forecast updateTime (UTC) | periods | active alerts at point |
|---|---|---|---|---|
| SMML1, KRZL1, BLRL1, MCGL1, AEXL1 | LCH | 2026-10-01T00:46:04Z | 14 | 0 |
| BTRL1, BXAL1 | LIX | 2026-09-30T22:36:55Z | 14 | 0 |
| MLUL1 | SHV | 2026-10-01T04:30:43Z | 14 | 0 |

- `updateTime` is per office run, not per point: all five LCH sites share one value. `generatedAt` is the request time, not the forecast time; use `updateTime` for freshness.
- No active alert at any site and `la_active=0` statewide at run time, while `us_active=303` nationally, so the endpoint works and Louisiana is quiet.
- NWS forecasts were 0.6–6.5 h old.

## Push vs poll

| feed | push available | mechanism | URL | what we tested | verdict |
|---|---|---|---|---|---|
| USGS Water Data | **no** (for machines) | WaterAlert: threshold alerts by email or text to a person. No webhook or API delivery. The OGC API has no subscription endpoint. | [usgs.gov/tools/wateralert](https://www.usgs.gov/tools/wateralert), [accounts.waterdata.usgs.gov/wateralert/](https://accounts.waterdata.usgs.gov/wateralert/) (HTTP 200), [OGC API docs](https://api.waterdata.usgs.gov/docs/ogcapi/) | Old `water.usgs.gov/wateralert/` now 301s to the National Water Dashboard. OGC response sends `cache-control: no-cache` and no ETag. | **Poll** every 15 min (data are 15-min), all sites in one request. WaterAlert could email a human, but we cannot receive it as data. |
| NOAA NWPS | **no** | None documented. The API page lists no subscription, webhook, or rate limit. | [water.noaa.gov/about/api](https://water.noaa.gov/about/api), [swagger.json](https://api.water.noaa.gov/nwps/v1/docs/swagger.json) | Swagger lists 11 GET/POST paths, none for subscription. Responses carry no ETag or cache headers. | **Poll** forecasts every 30–60 min, version on `issuedTime`; observed hourly. |
| NWS alerts | **yes**, with conditions | NWWS-OI: XMPP push, free, but needs an emailed application to NWWS.Issue@noaa.gov; "may take as long as 10-days or more". api.weather.gov has no stream or webhook; ATOM is a pull format. | [NWWS-OI request](https://www.weather.gov/nwws/nwws_oi_request), [NWS CAP](https://vlab.noaa.gov/web/nws-common-alerting-protocol), [API docs](https://www.weather.gov/documentation/services-web-api) | `alerts/active.atom?area=LA` → 200 `application/atom+xml`. JSON sends `cache-control: max-age=5` and a weak ETag, but `If-None-Match` with it returned **200**, not 304. | **Poll** `alerts/active?area=LA` every 1–2 min (one request covers all sites; match by point/zone locally). Apply for NWWS-OI only if alert latency under a minute becomes a requirement. |
| NWS forecasts | no | none | same | — | **Poll** hourly; version on `updateTime`. |

## Flood categories (stage, ft, NWPS)

| id | action | minor | moderate | major | stage now (NWPS) |
|---|---|---|---|---|---|
| SMML1 | 35 | 40 | 44 | 50 | 7.87 |
| KRZL1 | 28 | 29 | 40 | 43 | 3.92 |
| BLRL1 | 17 | 20 | 25 | 28 | 4.00 |
| MCGL1 | 4 | 6 | 7 | 12 | 3.37 |
| BTRL1 | 30 | 35 | 38 | 40 | 7.92 |
| AEXL1 | 28 | 32 | 36 | 40 | 20.01 |
| MLUL1 | 35.5 | 40 | 43 | 45 | 18.21 |
| BXAL1 | 16 | 18 | 21 | 23 | 6.11 |

Flow thresholds are `-9999` (not defined) everywhere except MLUL1. Treat `-9999`/`-999` as missing, never as a number.

## Default map camera

All 8 sites: lat 29.70–32.50, lon −92.44 to −89.82. Recommended default: **center 31.1, −91.1, zoom 7.5** (the 2.8° × 2.6° site box is about 335 px wide × 420 px tall at that zoom, so it fits with padding on a laptop map). The L'CARP focus preset is the Atchafalaya Basin: **center 30.35, −91.55, zoom 8.5** (Simmesport to Morgan City). Use `fitBounds([[-92.6, 29.5], [-89.6, 32.7]])` rather than a fixed zoom for narrow screens.

## Honest gaps and UI treatment

| gap | measured | UI treatment |
|---|---|---|
| No discharge at KRZL1, BLRL1, AEXL1 (USGS stage only) | `disch_ok=no` on 3 of 8 | Show "Flow: not measured at this gauge"; AEXL1 can show NWPS flow (2.22 kcfs) labelled "NWS estimate". |
| KRZL1 USGS stage on a different datum (−2.45 ft) | `DATUM` | Categories from NWPS stage only; evidence drawer shows both readings and says why. |
| Monroe flow disagrees 5.7–7× (NWPS 8.18 kcfs vs USGS 1430 / 1170 cfs) | `DATUM` | Show source next to every flow number; no blended flow. |
| Forecasts once a day; a missed day makes the forecast stale | `fcst_issued_h` 13.6–15.8 h | "Forecast issued 14 h ago". Mark stale after 36 h and drop the site's forecast from "needs review" scoring with the reason stated. |
| Statewide, many NWPS points have no current forecast | 340 LA gauges listed; 90 have a forecast series, 63 of those current (27 `fcst_not_current`, e.g. VLSL1 Vermilion at Surrey St) | Only offer sites with a forecast as candidates; if one goes `fcst_not_current`, show "No current river forecast" and keep observations. |
| Stale gauges exist | 76 of 340 LA NWPS gauges had no observation in the last 6 h (e.g. BSRL1 Bayou Sorrel Lock last 2026-09-30T12Z, COLL1 Columbia L&D 09-30T09Z) | Freshness dot per site: green ≤ 2 h, amber ≤ 6 h, red older; red removes the observation from the score with a reason. |
| Tidal noise at Morgan City | discharge 26900 → 22300 cfs in 1 h | Use 24 h means for flow and change at MCGL1. |
| NWPS keeps no forecast history | tested | Snapshot every issuance; backfill from IEM HML; state where replay coverage starts. |
| Alerts are usually zero | 0 at all 8 points, 0 statewide | "No active NWS alerts" is a positive statement with the check time, not an empty panel. |
| The feeds say nothing about carp | — | Copy and agent say conditions only, not abundance, catch, access or safety. |

## Licence and rate limits

- **USGS**: public domain. Anonymous OGC API use is rate limited per IP; the [keys page](https://api.waterdata.usgs.gov/docs/ogcapi/keys) says a key raises it ("before getting 429") and shows `X-RateLimit-Limit: 1000`. USGS's [dataRetrieval docs](https://water.code-pages.usgs.gov/dataRetrieval/articles/read_waterdata_functions.html) confirm "limits on how many queries can be requested per IP address per hour" but neither page states the anonymous number (a search snippet said 50/h; UNVERIFIED). Our anonymous responses carried no rate-limit headers. The probe uses 1 request per run; the server should get a free key and still batch all sites into one call.
- **NWPS**: NOAA public data. No published rate limit. ~2 requests per site per poll.
- **NWS api.weather.gov**: public domain. "The rate limit is not public information, but allows a generous amount for typical use"; retry after ~5 s ([docs](https://www.weather.gov/documentation/services-web-api)). A `User-Agent` is required.
- **IEM**: free, university-run. No published limit; cache and backfill once.

## G6: research claims

| claim | status | source (fetched 2026-10-01) |
|---|---|---|
| L'CARP launched May 2026 | **VERIFIED** | LDWF program page: "Officially launched in May of 2026, L'CARP is a team…" and "Run by Inversa, a multi-state Invasive species management company". Also: active "only in the Atchafalaya Basin, and only for Silver, Grass, Bighead, and Black carp". [wlf.louisiana.gov/page/louisiana-carp-removal-program](https://www.wlf.louisiana.gov/page/louisiana-carp-removal-program) |
| Louisiana Wildlife and Fisheries Commission April 2026 agenda mentions Inversa | **VERIFIED** | LDWF notice dated 2026-04-02 for the 2026-04-09 meeting, Vidalia. Item 10: "Presentation on INVERSA Modernizing Invasive Species Management through Technology…" (Henri Ferre'). [wlf.louisiana.gov/news/…-april-9-at-1000-am](https://www.wlf.louisiana.gov/news/louisiana-wildlife-and-fisheries-commission-to-meet-thursday-april-9-at-1000-am) |
| Origin "Detect, Deploy, Deliver" | **VERIFIED** | Origin page has three numbered pillars: "001 · Detect", "002 · Deploy", "003 · Deliver". [inversa.com/origin](https://inversa.com/origin) |

Two corrections to the ChatGPT brief: L'CARP covers **black** carp too, and does not list common carp (the brief listed common, not black), and its scope is the Atchafalaya Basin only. Default site focus should be Atchafalaya.
