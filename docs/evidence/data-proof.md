# L1 data proof: lionfish in four areas

Run: `bun scripts/probe-lionfish.ts` at 2026-10-01T04:48Z. Live public APIs, no keys. Every number below comes from that run; re-run the script to refresh.

Species filter:

- iNat `taxon_id=47284` (genus *Pterois*) + `introduced=true`
- GBIF `taxonKey=2334432` + `occurrenceStatus=PRESENT`
- NAS `genus=Pterois` (*P. volitans/miles*)

Day windows are on the **observed** date: iNat `d1=today-N`, GBIF `eventDate`. Created-date counts are reported separately.

## Counts per area

Bboxes are given as west, south, east, north.

### fl: Florida Keys / South Florida, `-83.2,24.3,-79.8,27.5`

| metric | value |
|---|---|
| iNat observed last 7 / 30 / 90 d | 0 / 3 / 21 |
| iNat 90 d without `introduced=true` | 22 |
| iNat submitted last 90 d (`created_d1`) | 30 |
| iNat all time / research grade | 374 / 288 |
| GBIF all time / from the iNat dataset / event date last 90 d | 2510 / 215 / 8 |
| USGS NAS all time / newest record | 3691 / 2026-05-14 |
| newest observed / newest submitted (iNat) | 2026-09-18 / 2026-09-26 |

### mx: Mexican Caribbean, `-87.9,18.3,-86.6,21.7`

| metric | value |
|---|---|
| iNat observed last 7 / 30 / 90 d | 5 / 8 / 24 |
| iNat 90 d without `introduced=true` | 24 |
| iNat submitted last 90 d | 36 |
| iNat all time / research grade | 791 / 775 |
| GBIF all time / from iNat / last 90 d | 441 / 268 / 16 |
| USGS NAS all time / newest | 319 / 2026-02-13 |
| newest observed / newest submitted | 2026-09-28 / 2026-09-30 |

### bz: Belize, `-88.5,16.0,-87.3,18.2`

| metric | value |
|---|---|
| iNat observed last 7 / 30 / 90 d | 0 / 0 / 1 |
| iNat 90 d without `introduced=true` | 1 |
| iNat submitted last 90 d | 2 |
| iNat all time / research grade | 165 / 162 |
| GBIF all time / from iNat / last 90 d | 151 / 137 / 1 |
| USGS NAS all time / newest | 33 / 2026-02-24 |
| newest observed / newest submitted | 2026-07-23 / 2026-08-05 |

### co: Colombian Caribbean, `-81.8,9.7,-74.0,13.5`

| metric | value |
|---|---|
| iNat observed last 7 / 30 / 90 d | 2 / 2 / 4 |
| iNat 90 d without `introduced=true` | 4 |
| iNat submitted last 90 d | 6 |
| iNat all time / research grade | 67 / 57 |
| GBIF all time / from iNat / last 90 d | 310 / 27 / 1 |
| USGS NAS all time / newest | 47 / 2016-02-23 |
| newest observed / newest submitted | 2026-09-29 / 2026-09-29 |

## Recommended bboxes

| area | bbox (W,S,E,N) | reason |
|---|---|---|
| fl | `-83.2,24.3,-79.8,27.5` | Dry Tortugas to Jupiter Inlet: the whole Florida reef tract plus the SW Gulf shelf. Same box the GBIF fixture already uses. |
| mx | `-87.9,18.3,-86.6,21.7` | Holbox, Isla Mujeres, Cancún, Cozumel, Tulum, Mahahual and Banco Chinchorro (18.4–18.8 N). The south edge stops at 18.3 N so it does not overlap Belize. |
| bz | `-88.5,16.0,-87.3,18.2` | Barrier reef, Turneffe, Lighthouse and Glover's. The first draft (`-88.5,15.8,-86.8,18.2`) picked up Honduras and Guatemala: NAS states `BZ, HN, GT`, and the newest iNat record (2026-09-18) was at 15.82 N, -88.01, "Cortés, HN". Moving the south edge to 16.0 and the east edge to -87.3 (west of Utila) removes them. NAS states are now `BZ` only. |
| co | `-81.8,9.7,-74.0,13.5` | San Andrés and Providencia plus the mainland coast from Cartagena to Santa Marta/Tayrona. The first draft stopped at -75.3 and missed Santa Marta: all-time iNat went from 32 to 67 and GBIF from 89 to 310 when the edge moved to -74.0. The south edge at 9.7 N keeps out Panama's Colón/San Blas records, which iNat has (9.23–9.59 N). Most of the box is open sea. A later version could use two boxes (islands plus coast) if the area model allows it. |

## Verdict

Density threshold: iNat lionfish observations dated in the last 90 days, in the box.

- **≥ 10:** keep. That is roughly one report every 9 days, enough for a 30-day vs previous-30-day comparison to have data on both sides.
- **1–9:** thin. Fewer than 5 is always thin.
- **0, with no GBIF event in 90 days:** cut.

| area | iNat 90 d | verdict |
|---|---|---|
| fl | 21 | **keep** |
| mx | 24 | **keep** |
| bz | 1 | **thin** |
| co | 4 | **thin** |

## Duplicates: iNat vs GBIF

Method: ID match. Take the research-grade iNat records submitted in the last 90 days, then query GBIF with `datasetKey=50c9509d-22c7-4a22-a47d-8c48425ef4a7` (the iNat Research-grade dataset) and `catalogNumber=<inat id>`.

| area | iNat research grade, created 90 d | found in GBIF | share of all-time GBIF records that come from iNat |
|---|---|---|---|
| fl | 18 | 14 (78%) | 8.6% (215 / 2510) |
| mx | 35 | 26 (74%) | 60.8% (268 / 441) |
| bz | 2 | 2 | 90.7% (137 / 151) |
| co | 6 | 2 | 8.7% (27 / 310) |

What this means:

- In Belize, nine in ten GBIF lionfish records are iNat copies. In Mexico it is six in ten. GBIF must be deduped by `catalogNumber` before it counts as a second source.
- Recent iNat research-grade records that are missing from GBIF are expected. GBIF ingests iNat weekly, and records under all-rights-reserved licences are never exported.
- In Florida and Colombia, most GBIF records come from other datasets: REEF surveys, museums, and NAS mirrored into GBIF. Those can overlap NAS. The overlap is not measured here; L2 should dedupe on coordinates plus date.

## Observed vs submitted lag (iNat)

Sample: every lionfish record submitted (`created_d1`) in the last 90 days. Lag is `created_at − observed_on`, in whole days.

| area | n | median (d) | p90 (d) | submitted > 30 d after observation |
|---|---|---|---|---|
| fl | 30 | 1 | 3293 | 9 |
| mx | 36 | 12 | 2099 | 12 |
| bz | 2 | 398 | 398 | 1 |
| co | 6 | 26 | 757 | 2 |
| **all** | 74 | **5** | **2099** | 24 |

The distribution splits into two groups:

- About two thirds of records (50 of 74) arrive within 30 days of the dive. The pooled median is 5 days.
- About a third are old photos uploaded months or years later. The p90 is over five years.

So "newly submitted" and "recently observed" have to be separate filters. They are the agent's data-quality question 5. A 90-day window keyed on `created_at` would have counted 30 Florida records instead of the 21 actually observed in that window.

## NOAA Coral Reef Watch

| area | reef cell | date | SST °C | anomaly °C | DHW °C-weeks | BAA |
|---|---|---|---|---|---|---|
| fl (Looe Key) | 24.525, -81.375 | 2026-09-29 | 30.04 | 1.52 | 13.65 | 1 |
| mx (Banco Chinchorro) | 18.575, -87.325 | 2026-09-29 | 29.88 | 1.24 | 7.85 | 3 |
| bz (Glover's) | 16.775, -87.825 | 2026-09-29 | 29.85 | 1.18 | 5.28 | 3 |
| co (San Andrés) | 12.525, -81.625 | 2026-09-29 | 29.48 | 1.12 | 0.93 | 2 |

**Access.** ERDDAP griddap, JSON output. CRW CoralTemp v3.1, 5 km, daily. Variables: `CRW_SST`, `CRW_SSTANOMALY`, `CRW_DHW`, `CRW_BAA`. One request per point, nearest cell:

```
https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json?CRW_SST[(last)][(lat)][(lon)],CRW_SSTANOMALY[...],CRW_DHW[...],CRW_BAA[...]
```

- The NOAA CoastWatch dataset `coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW` answers with an HTTP 302 to this same PacIOOS dataset, so the adapter should call PacIOOS directly and keep CoastWatch as the documented origin.
- No NetCDF or THREDDS is needed.
- The newest time step was 2026-09-29T12:00Z when the probe ran at 2026-10-01T04:48Z, so latency is about 1.7 days. The feed counts as fresh while it is no more than 2 days behind.

**BAA is not "max DHW".** Florida has DHW 13.65 but BAA 1 (Watch), because BAA alert levels also require the current HotSpot to be ≥ 1 °C. The Keys have cooled, while the accumulated stress remains. The score has to use DHW for accumulated stress and BAA as the current state, and show both.

**Licence.** CRW products are free to use "without restriction" but must credit NOAA Coral Reef Watch and cite the dataset DOI (dataset `license` attribute, `info/dhw_5km/index.csv`). The same attribute carries an OSTIA statement: Met Office, academic use only, 1985–2002. It covers only the climatology inputs for 1985–2002. Live 2026 values fall under GHRSST "free and open" plus the CRW statement. The evidence card should still show the CRW credit.

**Rate limit.** None is published, and no rate-limit or retry headers are sent. ERDDAP etiquette applies: one small request per area per day is far below any concern. Cache daily.

## Open-Meteo Marine

| area | point | wave height (m) | wave period (s) | current velocity (km/h) | current direction (°) | valid hours |
|---|---|---|---|---|---|---|
| fl | 24.55, -81.4 | 0.86 | 3.95 | 0.4 | 0 | 72 |
| mx | 18.6, -87.3 | 1.16 | 5.05 | 0.8 | 315 | 72 |
| bz | 16.8, -87.8 | 1.02 | 5.1 | 1.0 | 202 | 72 |
| co | 12.5, -81.65 | 1.02 | 5.7 | 1.9 | 241 | 72 |

- Variables: `hourly=wave_height,wave_period,ocean_current_velocity,ocean_current_direction&forecast_days=3`.
- Current velocity comes back in **km/h**, not m/s. The units need converting for display.
- Licence: the free tier is non-commercial use only, with CC BY 4.0 attribution. If Inversa deploys this commercially, a paid API key is needed. Flag for L4.

## Coverage of the other sources

| area | NAS records | buoys with fresh WTMP within 1° (NDBC realtime2, ≤ 3 d) | CO-OPS watertemp stations within 1° | GOES-19 SST |
|---|---|---|---|---|
| fl | yes (3691) | 55 of 75 listed | 13 | yes (full disk, 25.3° from the sub-satellite point) |
| mx | yes (319) | 0 (none listed) | 0 | yes (22.1°) |
| bz | yes (33) | 0 (none listed) | 0 | yes (20.9°) |
| co | yes (47, newest 2016-02-23) | 1 (42058 at 14.11 N, -75.95: central Caribbean, 0.6° north of the box) | 0 | yes (14.0°) |

**NAS is not US-only.** A global `genus=Pterois` pull returns 12,418 records. Their `state` values include `Mexico`, `MX`, `Quintana Roo`, `BZ`, `COL`, `Bolívar`, `HN` and others. Mexico and Belize records reach February 2026. Colombia's newest is from 2016.

- The API has no bbox parameter, so the probe pulls everything and filters on `decimalLatitude/Longitude`.
- One page of 5000 rows takes about 26 s, so the probe fetches four 4000-row pages in parallel.
- The current `nas.rs` filters `state=FL`. L2 should drop that filter and filter by bbox instead.

**GOES-19 SST.** The repo already decodes `ABI-L2-SSTF`, the full-disk product. It is posted hourly: the newest file was `ABI-L2-SSTF/2026/274/03/...`. There is no CONUS SST sector (`ABI-L2-SSTC` lists 0 keys). Full disk is centred on -75.2°, so all four areas are well inside it.

**Buoy vs satellite conflict.** This only works in Florida. Mexico and Belize have no NDBC or CO-OPS sea-temperature station. Colombia has only the offshore buoy 42058.

## Gaps and fallback

- **Belize is thin:** 1 iNat record in 90 days, 0 in 30 days. GBIF has one event in 90 days, and 91% of its Belize records are iNat copies. NAS's newest Belize record is 2026-02-24. Lionfish are present (165 iNat all time), but nobody uploads them now. A "recent reports" component for Belize would be built on one point.
- **Colombia is thin:** 4 iNat records in 90 days. Most of GBIF's 310 records are older survey data, and NAS stops in 2016. One of the 4 is a mid-sea point ("Mar Caribe", 12.46 N, -76.92), likely obscured or misplaced. There are no buoys inside the box.
- **Florida is thinner than expected for live sightings:** 21 in 90 days and **0 in the last 7**, despite 3691 NAS records. Recent-report counts here are low single digits per week, so "no reports this week" must read as "no reports", not "no lionfish".
- **No ground-truth SST outside Florida.** The buoy-vs-satellite conflict case can only be demoed in the Keys.

Fallback, reducing geography before adding feeds:

1. Keep **fl** and **mx** as the primary areas, and the demo default.
2. Merge **bz** into **mx** as one "Mesoamerican Reef" preset, `-88.5,16.0,-86.6,21.7`, if the area model needs ≥ 5 recent records per area. Measured: 26 iNat records in 90 days, 9 since 2026-09-01. Otherwise keep Belize as a labelled thin area that shows CRW heat stress and history (GBIF, NAS) but no recent-report score.
3. Keep **co** as a labelled thin area. It is useful precisely as the honest-gap example: elevated SST anomaly, sightings too sparse to rank, NAS history stopping in 2016. If the demo can only afford three areas, cut it. Do not add a feed (REEF, AGRRA) to rescue it.
4. Drop `introduced=true` from the iNat query for these boxes. Every Atlantic *Pterois* is introduced, and the filter silently loses records that lack place establishment data. Measured over 90 days in Florida: 21 records with the filter, 22 without. All-time Belize lost 12 in the first draft box (216 vs 228).
