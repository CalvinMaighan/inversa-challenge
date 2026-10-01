# Lionfish Watch: pivot spec (draft, 2026-10-01)

Supersedes the "Florida only, four species" scope in `docs/PRD.md` and `docs/research.md` decision 1. Evaluate against `docs/TASK_BRIEF.md`. Origin of the idea: ChatGPT suggestion, adapted to keep our stack.

## Question

> Where should we prioritize lionfish surveys, based on recent sightings, reef heat stress, and changing ocean conditions?

User: a conservation analyst deciding where to investigate next, seeing the evidence, and replaying how it changed.

## Scope

- **Species:** lionfish only (*Pterois volitans/miles*) is enabled. Species is a config unit: taxa, areas, feeds, score rules, agent prompt, eval set, copy. Python (or any other species) later becomes a second config on the same UI, one vertically integrated dashboard per species with its own helper questions, agent persona and benchmark. Python/tegu/iguana code stays but is disabled and unreachable in the lionfish build.
- **Four areas** (map presets; bboxes to validate against data density in the first two hours):
  1. Florida Keys / South Florida
  2. Mexican Caribbean (Quintana Roo, Banco Chinchorro)
  3. Belize
  4. Colombian Caribbean (San Andrés / Providencia, Cartagena coast)
- Every metric, layer, hotspot, answer and eval case is lionfish in these four areas. Out-of-area questions get a refusal that names the four areas.
- **Window:** 90-day backfill plus ongoing collection.
- Brand: the app is called **Lionfish Watch** (title, header, share links, agent persona, demo script).

## Feeds

| Feed | Role | Freshness story | Status in repo |
|---|---|---|---|
| iNaturalist | Recent sightings, photos, ID quality | Minutes, but observed date lags submitted date | Exists (`inat.rs`): re-point to 4 areas |
| NOAA Coral Reef Watch (SST, anomaly, bleaching heat stress, 5 km daily) | Reef heat stress | Daily | **New adapter** |
| Open-Meteo Marine | Waves, currents: fieldwork windows | Hourly modeled forecast | Exists (`openmeteo.rs`): add marine currents, 4 areas |
| GBIF | History, and the duplicate-of-iNat case | Days to weeks lag | Exists (`gbif.rs`): dedupe against iNat so it is never counted as corroboration |
| USGS NAS | Authoritative lionfish records | Weeks to months, **US only** | Exists (`nas.rs`): Florida only, so Mexico/Belize/Colombia show as a labeled coverage gap |
| NDBC / CO-OPS buoys | Ground truth SST vs satellite (conflict case) | 10 min to 1 h | Exists: add Caribbean buoys where they exist |
| GOES-19 SST | Satellite SST, disagrees with buoys | Minutes | Exists (`goes_*`): confirm sector covers Belize/Colombia (CONUS sector may not; full disk would) |

Dropped: USGS Water, NWS alerts (US-only, no lionfish value), GOES fire/land-temperature products.

## Honesty rules (these are graded as "data judgment")

- Sightings are not abundance or spread. More reports can mean more observers; no reports can mean no sampling. The UI and agent say so.
- Heat stress is context, not proof of lionfish damage to reefs.
- No single "invasion risk: 87%". The priority score shows components separately: recent reports, identification quality, heat stress, data completeness. Weights are configurable and the heuristic is labeled.
- Field conditions (waves, currents) are kept separate from ecological priority.
- Every answer carries feed state: fresh, stale, missing, conflicting.

## Tech kept

WebRTC (team board and cursors), WebSockets (live ingest push), GraphQL, active-state, web workers, SQLite (client db worker). Unchanged architecture; only domain content changes. "New to me" technology stays whatever `README.md` already claims; PostGIS from the suggestion is **not** adopted because we run SQLite and a Rust API.

## Agent benchmark

Golden set in `apps/web/eval/golden.ts`, rebuilt for lionfish. Each case checks tool choice, grounding (every number traces to a source row), view state change, and feed-state disclosure. Categories, at least 5 cases each:

1. **Sightings:** "Show recent lionfish reports near reefs with elevated heat stress in Belize." Map and timeline filter; evidence listed.
2. **Compare in time:** "Compare this with the previous month." Timeline moves, deltas stated.
3. **Explain:** "Why did you highlight this area?" Opens evidence card: observation, CRW cell, timestamps, source links.
4. **Ocean data relevance:** what SST, anomaly, DHW, degree heating weeks, waves and currents mean for lionfish surveys and why each is in the score. Cites the source and its limits.
5. **Data quality:** "Which areas have newly submitted reports of older sightings?", "Which highlighted areas have the freshest supporting data?", buoy vs satellite SST disagreement, GBIF/iNat duplicates, NAS missing outside Florida.
6. **Field planning:** "Where are waves forecast calmer over the next three days?" Kept separate from priority.
7. **Sources:** "Where does this number come from?" Every answer can name feed, URL, fetch time and license.
8. **Refusals and boundaries:** other species, areas outside the four, "is the population growing?", "what is the invasion risk percent?".

Pass bar: all categories pass with no ungrounded numbers, no stale data narrated as live, and no causal claims.

## Work breakdown (proposed leaves, to be added to `PLAN.md`)

- **L1 Data proof (first, 2 h):** pull lionfish from iNat, GBIF, NAS in the four bboxes; fetch CRW and Open-Meteo Marine at those points; tune bboxes; if coverage is sparse, cut areas before adding feeds. Output: `docs/evidence/data-proof.md`.
- **L2 Config:** replace species and region config with lionfish and four areas (`model.rs`, `hotspot/rules.rs`, seed data).
- **L3 CRW adapter:** `api/src/ingest/poll/crw.rs`, fixtures, quality rules, feed state.
- **L4 Marine:** currents and waves in `openmeteo.rs`.
- **L5 Score:** `hotspot/score.rs` rebuilt as four visible components; backtest kept.
- **L6 UI:** Lionfish Watch branding, four-area presets, evidence card, copy changes.
- **L7 Agent:** prompt, tools, golden set, eval run; gate on the benchmark above.
- **L8 Docs:** `docs/PRD.md`, `docs/brief-compliance.md`, `docs/demo-script.md`, `README.md`, interview notes.
- **L9 Redeploy and verify**, human blockers as before.

## Open points

- Final bboxes depend on L1.
- NAS and GOES coverage outside Florida must be confirmed in L1.
- This is a large rewrite of work already built (T1–T44). Existing gates will break and need rewriting per leaf.

## L1 results (2026-10-01, verified: `gate-check --status gates/leaf-L1.md` 6 met; evidence `docs/evidence/data-proof.md`)

Decision: keep all four areas as requested; thin areas show an honest sparse-data state (brief Q2), not a cut.

| Area | Bbox (W,S,E,N) | iNat 7/30/90 d | GBIF | NAS | Verdict |
|---|---|---|---|---|---|
| fl Florida | -83.2,24.3,-79.8,27.5 | 0/3/21 | 2510 | 3691 | keep |
| mx Mexican Caribbean | -87.9,18.3,-86.6,21.7 | 5/8/24 | 441 | 319 | keep |
| bz Belize | -88.5,16.0,-87.3,18.2 | 0/0/1 | 151 | 33 | thin |
| co Colombian Caribbean | -81.8,9.7,-74.0,13.5 | 2/2/4 | 310 | 47 | thin |

Corrections to this spec from the evidence:
- **NAS covers more than Florida** (Mexico, Belize, Colombia records exist; Colombia newest 2016). Drop the `state=FL` filter in `nas.rs`, filter by bbox client-side (no bbox parameter; pages are slow, fetch in parallel). The "NAS missing outside Florida" quality case becomes "NAS stale outside Florida".
- **CRW access:** ERDDAP griddap JSON, `https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km.json` (`CRW_SST`, `CRW_SSTANOMALY`, `CRW_DHW`, `CRW_BAA`), about 1.7 days latency. Free with credit to NOAA CRW and DOI. No published rate limit.
- **Show both DHW and bleaching alert level:** Florida had DHW 13.65 with alert level 1, so they can disagree.
- **Buoys:** only Florida has SST buoys, so the buoy-vs-satellite conflict case is Florida only. GOES-19 full-disk SST (`ABI-L2-SSTF`) covers all four areas; no CONUS SST product exists.
- **Dates:** observed vs submitted lag median 5 d, p90 2099 d. Windows count by observed date; the UI says so.
- **Duplicates:** GBIF copies of iNat are 90.7% in Belize, 60.8% Mexico, 8.6% Florida. Dedupe by iNat id.
- **Drop `introduced=true`** on iNat (it loses records; every Atlantic lionfish is introduced).
- **Open-Meteo Marine:** currents in km/h; free tier is non-commercial.
- **Florida had 0 iNat records in the last 7 days.** Default window for this app is 30 days, with 7 d and 90 d options.
