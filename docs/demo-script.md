# Demo script

Skeleton for the demo walkthrough. T32 extends it; this part covers the recorded cold snap scene.

## Scene: South Florida cold snap, 30 Jan – 3 Feb 2026

A cold front came through on 31 January 2026. Metro Miami dropped to about 2 °C on the mornings of 1 and 2 February, the coldest readings of the 2024–2026 winters. Green iguanas went torpid and fell out of trees. FWC let the public bring in cold-stunned iguanas, and NBC6 reported more than 1,000 handed in at the Sunrise office on 1 February alone.

- Scene id: `cold-snap-2026-02-01`
- Window: `2026-01-30T00:00:00Z` to `2026-02-04T00:00:00Z` (five UTC days)
- Files: `api/fixtures/scenes/cold-snap-2026-02-01/` (1.3 MB), with `manifest.json` and the recorder `fetch.sh`

### Sources in the scene

| Source | What was recorded | Link |
|---|---|---|
| iNaturalist | Every observation of the four focus taxa in the bbox, observed 30 Jan – 3 Feb: 141, all green iguana. No python, tegu or lionfish reports those days. | [API query](https://api.inaturalist.org/v1/observations?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=238252,318758,35342,47284&d1=2026-01-30&d2=2026-02-03&order_by=id&order=asc&per_page=200) |
| Open-Meteo historical archive | Hourly `temperature_2m`, `precipitation`, `wind_speed_10m` at the live poller's 182-point 0.25° grid | `archive-api.open-meteo.com/v1/archive` (full URL in the manifest) |
| Open-Meteo marine | Hourly `wave_height`, `sea_surface_temperature` at the same grid | `marine-api.open-meteo.com/v1/marine` (full URL in the manifest) |
| USGS NWIS | Instantaneous values (stage, lake elevation, water temperature) for the Everglades box sites, `startDT`/`endDT` over the window | `nwis.waterservices.usgs.gov/nwis/iv/` (two 100-site requests, URLs in the manifest) |
| NWS Miami and Key West | The 21 Non-Precipitation Weather products (`NPWMFL`, `NPWKEY`) issued 30 Jan – 3 Feb, raw text from the Iowa Environmental Mesonet AFOS archive | [IEM product list](https://mesonet.agron.iastate.edu/api/1/nws/afos/list.json?pil=NPWMFL&date=2026-01-31), [VTEC events MFL 2026](https://mesonet.agron.iastate.edu/json/vtec_events_bywfo.py?wfo=MFL&year=2026) |

The key NWS events, from the IEM VTEC listing:

| Event | VTEC | In effect (UTC) | Zones |
|---|---|---|---|
| Extreme Cold Warning | `KMFL.EC.W.0001` | 1 Feb 03:00 – 15:00 | interior and southwest Florida (FLZ063, 066, 067, 068, 168) |
| Freeze Warning | `KMFL.FZ.W.0003` | 1 Feb 03:00 – 15:00 | includes Metro Broward (FLZ072) and Metropolitan Miami-Dade (FLZ074) |
| Freeze Warning | `KMFL.FZ.W.0004` | 2 Feb 00:00 – 14:00 | same metro zones |
| Freeze Warning | `KMFL.FZ.W.0005` | 3 Feb 04:00 – 14:00 | interior only |
| Cold Weather Advisory | `KMFL.CW.Y.0007` – `0009` | nights of 1, 2, 3 Feb | metro and coastal zones |
| Frost Advisory | `KMFL.FR.Y.0001` | 3 Feb 04:00 – 14:00 | FLZ073, 075, 174 |
| Cold Weather Advisory | `KKEY.CW.Y.0001`, `0002` | nights of 1 and 2 Feb | Florida Keys (FLZ076) |

The event is also confirmed by:
- Open-Meteo daily minimum at Miami (25.775 N, 80.325 W): 1.9 °C on 1 and 2 Feb, 4.6 °C on 3 Feb ([query](https://archive-api.open-meteo.com/v1/archive?latitude=25.775,25.475&longitude=-80.325,-80.475&start_date=2024-11-01&end_date=2026-03-31&daily=temperature_2m_min&timezone=America/New_York)). Homestead read 2.3 °C and 2.5 °C.
- iNaturalist iguana reports per day in the bbox: 8, 10, 63, 32, 28 for 30 Jan to 3 Feb ([histogram](https://api.inaturalist.org/v1/observations/histogram?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=35342&d1=2026-01-20&d2=2026-02-12&interval=day&date_field=observed)).
- News coverage:
  - [NBC6 Miami](https://www.nbcmiami.com/news/local/historic-cold-snap-leaves-iguanas-immobilized-in-south-florida/3757935/): over 1,000 green iguanas turned in to FWC in one day.
  - [AccuWeather](https://www.accuweather.com/en/winter-weather/florida-cold-snap-delivers-falling-iguanas-snow-flurries-and-record-breaking-lows/1859306): photos of cold-stunned iguanas in Miami Beach on 1 Feb.
  - [Miami Herald](https://www.miamiherald.com/news/weather-news/article314577533.html).

### How the payloads were converted

Everything the scene ingests is the upstream response, byte for byte. Files over about 1 MB are stored gzipped, and the loader inflates them. There are two exceptions.

- **Open-Meteo:** the archive and marine APIs answer in the same shape as the forecast API, so the `openmeteo` adapter parses them unchanged. The marine URL still starts with the marine host, which selects the marine variables.
- **NWS:** `api.weather.gov` serves only active alerts, so the scene uses IEM's text archive. Each product's raw text sits in `nws/raw/` exactly as IEM returned it. `nws/<product id>.xml` wraps that text, XML-escaped and otherwise unchanged, in the NWWS-OI groupchat stanza that the `nwws` push source receives live. The `<x>` attributes (issuance time, office, WMO header, AWIPS id) come from the IEM product id. `push::nwws::normalize_stanza` then parses segments, VTEC and UGC the same way it does live, and keys rows with the same `vtec_ext_id` the `api.weather.gov` poller uses. The IEM VTEC listings are kept in `nws/iem/` as the index.

Every payload is replayed with fetch time `replay_at` (`2026-02-04T00:00:00Z`, the window end). The real retrieval time is `recorded_at` in the manifest. Without this, the USGS adapter would drop every value as more than 30 days older than its fetch.

`sh api/fixtures/scenes/cold-snap-2026-02-01/fetch.sh` re-records the whole scene and rewrites the manifest.

## Load the scene

```sh
# into the dev database (idempotent: a second run leaves the data unchanged)
INVERSA_DATA_DIR=./data cargo run --manifest-path api/Cargo.toml -- backfill --scene cold-snap-2026-02-01

# or check it without touching any database
INVERSA_SOURCES=off cargo run --manifest-path api/Cargo.toml -- backfill --dry-run --scene cold-snap-2026-02-01
```

Measured output (dry run):

```
inat: payloads=1 rows_in=141 written=141 skipped=0 errors=0
openmeteo: payloads=2 rows_in=95520 written=95702 skipped=0 errors=0
usgs: payloads=2 rows_in=71167 written=71307 skipped=0 errors=0
nwws: payloads=21 rows_in=110 written=110 skipped=0 errors=0
scene cold-snap-2026-02-01 [2026-01-30T00:00:00Z, 2026-02-04T00:00:00Z): sightings=138 readings=165951 air_below_10c=5328 alerts=42
BACKFILL-DRY-RUN-OK
```

`written` includes the stations each reading source creates. `sightings=138` counts observations inside the UTC window. Three of the 141 were made on the evening of 3 Feb EST, which is after midnight UTC.

The test `scene_cold_snap` (`cargo test --manifest-path api/Cargo.toml scene_cold_snap`) loads the scene into memory and checks these counts, the NWS events, and the cold-stun term below.

The scene is months older than the live 30-day window, so the frame builder does not pre-build it. `GET /v1/frames?from=2026-01-30T00:00:00Z&to=2026-02-04T00:00:00Z` builds and stores the 120 hourly frames on first request. In the UI, jump there with `set_time` / `play_timeline`, which accept any RFC 3339 time. By voice: "show the first of February 2026 at 7 AM".

## Moments to scrub to

Times are UTC, with Miami local time (EST, UTC−5) in brackets.

1. **31 Jan 18:59 (1:59 PM).** NWS Miami's NPW adds the Metro Broward and Miami-Dade freeze warning (`FZ.W.0003`, action `EXA`). The alert band covers the metro from 1 Feb 03:00.
2. **1 Feb 03:00 (10 PM, 31 Jan).** The Extreme Cold Warning, Freeze Warning and Cold Weather Advisory take effect. An hour later the metro grid point (25.675 N, 80.325 W) is below 10 °C (9.0 °C at 04:00).
3. **1 Feb 12:00 (7 AM).** Coldest hour: the grid point at 25.675 N, 80.325 W reads 2.2 °C.
4. **1 Feb 15:00 – 18:00 (10 AM – 1 PM).** Iguana reports surge: 63 that day, against 8 and 10 on the two days before. Cell `292:142` (25.725 N, 80.275 W, Coral Gables / South Miami) gets three reports at 15:40–15:41 and four more from 17:43 to 18:08. At **17:00** it reads 7.0 °C and the iguana hotspot is doubled.
5. **2 Feb 12:00 (7 AM).** Second freeze night, 2.2 °C again, under `FZ.W.0004`. Reports stay high at 32.
6. **3 Feb 19:00 (2 PM).** The rebound: 19.1 °C at the same grid point. The cold-stun term drops back to 1.0 while the 1 Feb reports still carry density.

## What to ask the agent

- "Did the cold snap change iguana reports?" Expect the daily counts (8, 10, 63, 32, 28), tied to the sub-10 °C hours and the NWS warnings. Citations should include `sighting:`, `reading:` and `alert:` ids.
- "Why is cell 292:142 hot at noon on 1 February?" Expect `explain_cell` at `2026-02-01T17:00:00Z`. Density 0.79, `activity.iguana_cold_stun_easy_capture_window` 2.0, `access.land_access` 1.0, score 1.58. Conditions: air 7.0 °C, stage 0.9 m, wave 1.3 m, wind 5.4 m/s.
- "Same cell on 3 February at 2 PM?" Expect air 19.1 °C and the cold-stun term at 1.0. Density is the frame maximum there (1.0) and the score is 1.0.
- "Which alerts were in effect overnight on 31 January?" Expect Extreme Cold Warning, Freeze Warning, Cold Weather Advisory and Wind Advisory from NWS Miami, and Cold Weather Advisory from NWS Key West.
- "Were there any python or tegu reports during the cold snap?" Expect none in the window. Tegus are in brumation (the rule suppresses them October–February), and no python observations were posted.

## What the evidence drawer should show

- **Hotspot** `hotspot:iguana:292:142:1769965200000` (1 Feb 17:00 UTC): each term with its rationale. The cold-stun rationale reads "Green iguanas go torpid below about 10 °C air temperature and drop from trees".
- **Sighting** (for example one of the three `292:142` reports):
  - the normalized iNat record (research grade, `Iguana iguana`);
  - the raw iNat page as fetched (10.6 MB, so the inline text is cut at the drawer's 256 KB cap) and its source URL (the `d1`/`d2` query above);
  - fetch time `2026-02-04T00:00:00Z`, so the ingest lag is the time from the report to the end of the window (about 2 days 7 hours for a 15:40 UTC report on 1 Feb).
- **Reading** `reading:<station_id>:air_c:<ms>:modeled`: origin `modeled`, the Open-Meteo archive URL and the raw archive response.
- **Alert** (Freeze Warning `KMFL.FZ.W.0003`):
  - event, severity `Severe`, the product headline, onset 1 Feb 03:00 UTC, expiry 15:00 UTC;
  - the raw NWWS stanza with the original NPW text inside;
  - its source URL, the IEM `nwstext` link for that product.
