# Data sources: what we call, why, and what it earns against the brief

Scope decision (2026-10-01): the final feed list is the 15 sources below. GOES-19, GOES-19 SST and NWWS-OI are dropped because they need an AWS account and a NOAA application we do not have. The configs in `spec/apps/*.json` still list them until that removal lands, so treat this file as the target. Facts here come from `api/src/source_pages.rs` (the `source_facts` table the app itself serves through `sourceInfo`), `docs/ingest-modes.md`, and the measured data proofs in `docs/evidence/`. The brief is `docs/TASK_BRIEF.md`.

## What the brief asks, in four lines

1. Three or more relevant real-time feeds around one coherent question.
2. Backend that collects, stores and queries them; a natural-language interface across real-time and historical data; a timeline with replay.
3. Quality: accurate real-time data and clear treatment of stale, missing and conflicting data.
4. Answers that follow evidence to its source.

Each source below is scored against those four.

## Final list by app

| App | Question | Sources |
|---|---|---|
| **Carp** (default) | How have river and weather conditions changed around candidate carp-removal sites, and which need review? | USGS Water, NWPS, NWS alerts, NWS forecast, IEM archive, AISStream |
| **Lionfish Watch** | Where should lionfish surveys go, given sightings, reef heat stress and ocean conditions? | iNaturalist, GBIF, USGS NAS, Coral Reef Watch, Open-Meteo Marine, NDBC, AISStream |
| **Python** | Where are Burmese pythons active and where should crews go? | iNaturalist, GBIF, USGS NAS, NWS, USGS Water, NDBC, CO-OPS, Open-Meteo |

Counts: carp 6, lionfish 7, python 8, so each app clears the brief's minimum of three by a wide margin. Fifteen distinct sources in total.

## The sources

For each: what it is, how we call it, then the value to the brief. "Sample list" means the source appears in the brief's sample data source ideas.

### River and weather (carp, python)

**USGS Water Data** (`api.waterdata.usgs.gov`, OGC API continuous). Sample list. Observed stage and discharge at river gauges. We poll every 15 minutes with all sites in one request; the anonymous rate limit is per IP and unpublished, a free key raises it.
- *Real-time feed:* the "what is happening now" signal for carp (eight Louisiana gauges, newest reading 0.1 to 1.1 hours old when measured).
- *History:* a 7-day backfill in one request, which gives the timeline its observed line.
- *Quality case:* the gauge datum differs from NWPS (Krotz Springs shows 1.47 ft at USGS against 3.92 ft at NWPS at the same time), so we never compare USGS stage to flood thresholds and we label both. Flow at Monroe disagrees between sources by 5.7 to 7 times; we show both with their sources and never blend them.

**NOAA National Water Prediction Service** (`api.water.noaa.gov/nwps/v1`). Not on the sample list; it is NOAA's own river forecast service. River stage and flow forecasts, flood-category thresholds and gauge metadata. Polled every 15 minutes in the 12:00 to 18:00 UTC issuance window, hourly otherwise; a version is stored only when the issuance time changes.
- *Real-time feed:* what is expected next, 5 to 15 day horizons.
- *Replay:* NWPS keeps no archive, so we snapshot every issuance. That is what makes "what did we know yesterday afternoon" a true replay instead of a re-render.
- *Quality case:* gauges often lack the USGS id, so the site mapping is ours; missing thresholds and stopped gauges are reported, not filled.

**NWS API: alerts** (`api.weather.gov/alerts/active`). Sample list. Active warnings for Louisiana, matched to each site by polygon or zone. Polled every 60 seconds. Every poll, including empty ones, is recorded, so "no active alert" is a timestamped check and a dead poller reads "cannot assess" instead of "all clear".
- *Value:* the official conditions layer, and the clearest example of treating absence honestly.

**NWS API: gridpoint forecast** (`api.weather.gov/gridpoints`). Sample list. Forecast periods plus the raw grid: chance of precipitation, rainfall amount, wind gusts. Polled hourly; versioned on the office's update time.
- *Value:* weather context for field planning. It is labelled as weather at the grid cell, never as a stage or flood prediction. Added after the benchmark showed rain questions could not be answered without it.

**IEM river forecast archive** (`mesonet.agron.iastate.edu`, Iowa State). Not on the sample list. An archive of past NWS river forecasts. Read once at boot for the replay window, then daily.
- *Replay:* the reason carp replay does not start from our first snapshot. Each stored version records whether it came from the live NWPS or this archive.

**NWS (python)**. Sample list. The same NWS alerts API serves the Everglades; cold-snap products explain pythons and activity.

**USGS Water (python)**. Everglades and South Florida gauge heights and water temperature, which feed the python levee-stage rule.

### Wildlife (lionfish, python)

**iNaturalist** (`api.inaturalist.org/v1/observations`). Sample list. Citizen sightings with photos, positions and identification quality. Polled every 10 minutes with a conditional GET.
- *Real-time feed:* the "recent reports" signal, with a photo behind every dot.
- *Quality cases:* observed date and upload date differ a lot (median 5 days, 90th percentile about 2,099 days across the 74 lionfish records measured), so windows count by observed date and the UI says so. Identifications can flip.
- *Boundary:* sightings are not abundance. More reports can mean more observers; the product says so.

**GBIF** (`api.gbif.org/v1/occurrence/search`). Sample list. A global index of occurrence records with deep history. Polled daily.
- *History:* the deeper baseline.
- *Quality case:* many GBIF records are copies of iNaturalist (91% in Belize, 61% in Mexico, 9% in Florida for lionfish). We link each copy to its iNaturalist original and never count it as corroboration. That is the brief's "conflicting data" case on real data.

**USGS NAS** (`nas.er.usgs.gov/api/v2`). Not on the sample list. The authoritative non-native aquatic species records. Polled weekly. It covers more than Florida (Mexico, Belize and Colombia too).
- *Quality case:* it is stale outside Florida (Colombia's newest lionfish record is from 2016). The UI shows that gap instead of hiding it.

### Ocean and reef (lionfish)

**NOAA Coral Reef Watch** (ERDDAP, `pae-paha.pacioos.hawaii.edu`). Not on the sample list. Daily sea surface temperature, anomaly, accumulated heat stress (DHW) and bleaching alert level at 5 km, with about 1.7 days of latency. Fetched on an ERDDAP dataset-change nudge with a 3-hour backstop poll.
- *Value:* the "heat stress" signal of the lionfish question. Free to use with credit to NOAA CRW and a DOI.
- *Quality case:* DHW and the alert level can disagree (Florida showed DHW 13.65 with the lowest alert level), so the score shows both.

**Open-Meteo Marine** (`marine-api.open-meteo.com`). Sample list (Open-Meteo). Modeled waves and ocean currents, 72-hour horizon. We check `meta.json` every 15 minutes and fetch only when a new model run lands.
- *Value:* field planning conditions, kept separate from ecological priority. Free tier is non-commercial only, which matters for any paid deployment.

**NDBC buoys** (`ndbc.noaa.gov`). Sample list. Measured sea temperature, one bulk file every 10 minutes. Florida only: no sea-temperature buoys exist near the Mexican, Belizean or Colombian areas.
- *Quality case:* measured buoy temperature against satellite temperature (the Vaca Key buoy read 28.0 °C against 29.7 °C from Coral Reef Watch), a genuine measured-versus-modeled conflict.

### Coastal readings and air temperature (python)

**NOAA CO-OPS Tides & Currents** (`api.tidesandcurrents.noaa.gov`). Sample list. Coastal water level and conditions every 6 minutes.

**NDBC (python)**. Coastal air and water temperature from the same bulk file.

**Open-Meteo forecast** (`api.open-meteo.com`). Sample list. Forecast air temperature, which the transparent python activity rule uses (activity is boosted from 21 to 32 °C and suppressed below 15 °C).

### Vessels (carp, lionfish)

**AISStream** (`wss://stream.aisstream.io/v0/stream`). Not on the sample list; it is the brief's "human patterns" category. A websocket stream of ship positions in the app's areas, kept to one position per vessel per minute. The key is server side only and is set in Doppler as `AISSTREAM_API_KEY`.
- *Value:* the one real push feed. It adds vessel context to the river and reef maps, and it is the push mechanism the push-first story rests on. It does not feed any score.
- *Terms:* free in beta with no formal terms or SLA; three connections per account.

## How the sources earn the brief

| Brief requirement | Where it is met |
|---|---|
| Three or more real-time feeds on one coherent question | Carp 6, lionfish 7, python 8 |
| Mix of live, curated and lagged data | Minutes (iNaturalist, USGS, NDBC, AIS) to days (Coral Reef Watch, GBIF) to weeks (NAS) |
| Stale, missing and conflicting data handled visibly | Datum mismatch, flow disagreement, DHW against alert level, buoy against satellite, GBIF copies of iNaturalist, NAS in Colombia, observed against submitted dates, empty-alert checks |
| Historical exploration and replay | USGS 7-day backfill, IEM archive plus our snapshots (carp), 90-day iNaturalist and Coral Reef Watch window (lionfish) |
| Evidence to source | Every record links to the publisher's page through `sourceInfo` and the evidence drawer; links open in a new tab |
| Honest about what the data cannot say | No abundance, no spread, no catch, no flood prediction from weather, no risk percent |

## Push or poll

AISStream is the only push feed after the drop. The rest are polled by the Rust scheduler and delivered through the signed ingest hook; `docs/ingest-modes.md` records, for each poll, what was searched and why no push exists. Two optional webhook-style nudges (an ERDDAP subscription for Coral Reef Watch and IEMBot for carp) exist in the code but each needs a free sign-up and are not required.

## Not used, and why

| Source | Reason |
|---|---|
| GOES-19 (land and sea surface temperature) | Needs an AWS account with an SQS queue; dropped. Coral Reef Watch covers satellite sea temperature, and python's rule uses air temperature |
| NWWS-OI | Needs an emailed NOAA application (10 days or more); dropped. NWS alerts are polled instead |
| eBird | No coverage of our species |
| NASA FIRMS | Fires do not answer any of the three questions |
| Other sample-list sources (earthquakes, air quality, bike share, transit, flights, Wikipedia) | Not relevant to the questions we chose |
