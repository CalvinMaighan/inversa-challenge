# Interview notes

Prep for the three things the brief says to be ready for: the question and why it matters and why these sources; the design choices with their alternatives; and how the system grows. One section per app, then the hard questions I expect, with straight answers.

Rules for this file: every claim about Inversa or the world has a source URL and the date it was read, or is marked **unverified**. Every number is either re-measured on 2026-10-01 for leaf D1 (marked "re-measured") or quoted from a named gate or evidence file with its date. The long forms are `docs/design-alternatives.md` and `docs/scaling.md`.

The system: one Rust API, one Next.js UI shell and one agent runtime serve three apps, each a JSON config in `spec/apps/` with its own question, feeds, score, agent persona, helper questions and benchmark. Carp is the default app; the app selector switches by URL (`?app=carp|lionfish|python`). Each app has its own SQLite files, scheduler, frames builder and realtime hub; a sighting written in one app cannot be seen from another (`gates/leaf-A1a.md` G2).

## Carp: Louisiana river conditions

> How have river and weather conditions changed around candidate carp-removal locations, and which need operational review today?

### Why it matters to Inversa

- The Louisiana Department of Wildlife and Fisheries' carp removal program, L'CARP, "officially launched in May of 2026" and is "run by Inversa". It is active only in the Atchafalaya Basin, and only for silver, grass, bighead and black carp. Source: [wlf.louisiana.gov/page/louisiana-carp-removal-program](https://www.wlf.louisiana.gov/page/louisiana-carp-removal-program), read 2026-10-01 (`docs/evidence/carp-data-proof.md` G6).
- Inversa presented to the Louisiana Wildlife and Fisheries Commission on 2026-04-09 (agenda item 10, notice dated 2026-04-02): [wlf.louisiana.gov news](https://www.wlf.louisiana.gov/news/louisiana-wildlife-and-fisheries-commission-to-meet-thursday-april-9-at-1000-am), read 2026-10-01.
- Inversa's product Origin is organised as "Detect, Deploy, Deliver": [inversa.com/origin](https://inversa.com/origin), read 2026-10-01.
- What an operations manager needs before a crew goes out is the river: stage, flow, forecast, flood category and alerts, at the places crews work. That is public, real time and checkable. Carp themselves are not: they barely appear in iNaturalist, so this app is about conditions, not carp. The app says so on screen and the agent refuses abundance, catch, legal access and trip-safety questions.
- The eight sites (four in the Atchafalaya Basin, plus Baton Rouge, Alexandria, Monroe and Bogalusa) are labelled demonstration locations. Inversa's real operating areas are unknown to me.

### Why these data sources, and which were rejected

| Feed | What it contributes | How fresh (measured) |
|---|---|---|
| USGS Water Data, OGC API `continuous` (stage 00065, discharge 00060) | observed stage and flow, history, 24 h change | 15-minute values, newest 0.3 to 1.1 h old at all 8 sites in the C1 probe (2026-10-01) |
| NOAA NWPS (`api.water.noaa.gov/nwps/v1`) | river forecasts, flood categories, NWPS observed stage | one issuance a day per site, 13:17Z to 15:56Z on 7 of 7 days; observed hourly, about 55 min after valid time |
| NWS `api.weather.gov` alerts and gridpoint forecasts | official alerts for Louisiana; weather at each site | alerts polled every 60 s; forecasts 0.6 to 6.5 h old at probe time |
| Iowa Environmental Mesonet HML archive | past NWS river forecasts, so "what we knew" can be backfilled | 7 issuances per site in the last 7 days (C1 probe) |

Sources and tests: `docs/evidence/carp-data-proof.md`; modes and the provider URLs: `docs/ingest-modes.md` rows C1 to C7.

Rejected: iNaturalist carp sightings (too rare to carry a question), Open-Meteo and GOES-19 (useful only after the three core feeds worked; never needed), USGS WaterAlert as "push" (it emails or texts a person; no machine delivery). NWWS-OI is the one real push for NWS products; it is wired but waits on NOAA's account approval.

### Stale, missing and conflicting cases found in real data

- **KRZL1 datum mismatch.** At Krotz Springs USGS read 1.47 ft and NWPS 3.92 ft at the same time: a 2.45 ft datum offset. The flood thresholds (action 28 ft) belong to the NWPS gauge, so flood categories are computed from NWPS stage only. A test pins it: `review_rule_forecast_category_datum_trap_krzl1` (`gates/leaf-C5.md` G1).
- **Monroe flow disagreement.** At MLUL1 NWPS reported 8,180 cfs while USGS reported 1,430 cfs at the same hour and stage (a factor of 5.7; 7.0 in a second run). Not resolved; flow is always labelled with its source and never blended.
- **No forecast history at NWPS.** Its `issuedTime` and `asOf` parameters are ignored (tested). Replay is backfilled from IEM and every NWPS issuance we see is snapshotted; each snapshot records `nwps-live` or `iem-archive`, and the timeline marks where replay coverage starts.
- **Missing discharge** at KRZL1, BLRL1 and AEXL1: "not measured at this gauge", never zero.
- **Stale gauges and stale forecasts.** Statewide, 76 of 340 NWPS gauges had no observation in 6 h at probe time. A site whose observation or forecast is too old reads `cannot_assess`, not `ok` (`gates/leaf-C5.md` G3).
- **Empty alert lists.** Louisiana had no active alerts at probe time. "No active alerts" is recorded with the check time, so a dead poller cannot pass for a quiet day (`gates/leaf-E1.md` G3).
- **Tidal noise at Morgan City** (discharge 26,900 to 22,300 cfs in an hour): the rule uses a noise floor and 24 h means there.

### Limits of the heuristic

"Needs review" is a rule table (forecast category, rapid change, active alert, sources disagree, low water, stale input), each rule a pure function with its reason in words. It says what changed in the river, not whether carp are there, whether a trip is safe or how many fish a crew will catch. The eventful replay scene used in tests (`api/fixtures/carp_scene/rise-2026-05/`) is **synthetic** and labelled so; on the live data Louisiana was quiet (only MCGL1 at action stage on 2026-10-01).

## Lionfish: four Caribbean areas

> Where should we prioritize lionfish surveys, given recent sightings, reef heat stress and ocean conditions?

### Why it matters to Inversa

- Inversa's lionfish program operates in "Mexico, Colombia, Belize, and Florida", with NOAA, ORRAA and Conservation International among the partners, and reports 40,000+ lionfish removed and 267 fishers employed: [inversa.com/case/lionfish-management-program](https://inversa.com/case/lionfish-management-program), read 2026-10-01. Those are Inversa's own figures, not checked independently.
- The app's four areas are those four places: Florida Keys, Mexican Caribbean, Belize, Colombian Caribbean (bboxes chosen against data density in `docs/evidence/data-proof.md`).
- The user is an analyst deciding where to survey next. The honest output is an ordering of places to look, built from four visible components (recent reports, ID quality, heat stress, data completeness), never a single "invasion risk" percent.

### Why these data sources, and which were rejected

| Feed | What it contributes | How fresh (measured, L1 probe 2026-10-01) |
|---|---|---|
| iNaturalist (genus *Pterois*) | recent reports with photos and ID quality | minutes after upload, but upload lags the dive: median 5 days, p90 2,099 days (n=74) |
| NOAA Coral Reef Watch `dhw_5km` via PacIOOS ERDDAP | SST, anomaly, degree heating weeks (DHW), bleaching alert area (BAA) | daily; about 1.7 days behind at probe time |
| Open-Meteo Marine | waves and currents for field windows, kept apart from priority | hourly model, 72 h horizon; free tier is non-commercial |
| GBIF | history, and copies of iNat records | days to weeks |
| USGS NAS | curated history, including outside the US | weeks to years (Colombia's newest record is from 2016) |
| NDBC buoys | in-situ water temperature to check satellite SST | 10 min to 1 h; Florida only |

Rejected or dropped: CO-OPS, NWS alerts and NWWS (US-only, no lionfish value), the Open-Meteo land forecast, GOES land-temperature, fire and cloud products, and adding REEF or AGRRA survey data to rescue thin areas (the L1 decision was to label thin areas, not pad them).

### Stale, missing and conflicting cases found in real data

- **DHW vs BAA.** At Looe Key DHW was 13.65 °C-weeks while BAA was level 1 (Watch): accumulated stress stays high after the reef cools, and BAA also needs a current HotSpot of at least 1 °C. Both are always shown together (`gates/leaf-L3.md` G2).
- **Observed vs submitted lag.** About a third of records are old photos uploaded months or years later. A 90-day window keyed on upload date would have counted 30 Florida records instead of the 21 observed in that window. Windows count by observed date and the UI offers the other basis with an explanation (`gates/leaf-UL.md` G3).
- **GBIF copies of iNat.** 90.7% of Belize's GBIF lionfish records and 60.8% of Mexico's are iNaturalist copies (8.6% in Florida). They are linked to their iNat record and never counted as a second source.
- **Colombia NAS 2016.** NAS has Colombian records, but the newest is from 2016-02-23; that reads as stale, not current.
- **Thin areas.** Belize had 1 iNat record in 90 days, Colombia 4, and Florida 0 in the last 7 days. "No reports" means no reports, not no lionfish; thin areas are drawn dashed and labelled.
- **Buoy vs satellite.** The SST conflict case only exists in Florida; Mexico and Belize have no NDBC or CO-OPS temperature station.

### Limits of the heuristic

The components are hand-weighted; the weights are in config and shown. Reports measure observer effort as much as lionfish. Heat stress is context, not proof that lionfish did anything. The lionfish backtest reports thin regions as insufficient data rather than scoring them (`gates/leaf-L5.md` G4).

## Python: Everglades Ops

> Where are Burmese pythons active and where should removal crews go next?

### Why it matters to Inversa

- FWC's release of 2025-10-21 says FWC "partnered with Miami-based company Inversa" last year to triple python removals in two years, and that 1,022 pythons were removed in May to July 2025 against 343 in the same period of 2024, with 748 in July 2025 alone: [myfwc.com/news/all-news/gov-python-removal-1025](https://myfwc.com/news/all-news/gov-python-removal-1025/), read 2026-10-01. The same release names FWC's PATRIC contractor program. That Inversa *administers* PATRIC, as earlier drafts of these docs said, is **unverified**: the release says partnered, not administers. Earlier drafts also said "235 removals in July 2024"; the FWC release does not contain that number and the secondary source it may come from (News From The States) answered 403 on 2026-10-01, so it is **unverified** and not used.
- Origin, per [inversa.com/origin](https://inversa.com/origin) (read 2026-09-30 for `docs/research.md`), describes a loop from invasive hotspot to mission to ROI. The python app is the hotspot half of that loop, on public data.
- Python was the first build; carp and lionfish reuse its engine.

### Why these data sources, and which were rejected

| Feed | What it contributes | How fresh (measured in the T28 70-minute live run, `docs/perf.md`) |
|---|---|---|
| iNaturalist (*Python bivittatus*) | sightings with photos and ID changes | polled within cadence; newest observation 3,591 s old at the end of the run |
| USGS NAS | curated python records | newest 131 days old: stale by design |
| GBIF | deep history, iNat mirrors | newest 10 days old: lagging |
| NWS alerts (poll), NWWS-OI (push, pending) | freeze, cold and heat alerts: cold snaps suppress and kill pythons | alerts 40 s behind at the end of the run |
| USGS Water | Everglades stage and water temperature | 1,406 s |
| NDBC, CO-OPS | buoy and tide-gauge water temperature and level | 2,006 s and 686 s |
| Open-Meteo forecast | air temperature, rain, wind | hourly |
| GOES-19 ABI L2 (push, pending) | land and sea surface temperature, fire, cloud | push over SQS once an AWS queue exists |

Rejected: eBird (no python records), NASA FIRMS (GOES fire product covers it), aisstream (vessel traffic does not answer the question), Firecrawl monitors of FWC pages (no app needs them).

### Stale, missing and conflicting cases

- iNat identification flips become a revision row and a conflict flag; GBIF mirrors of iNat become one pin with "duplicate of" links; NAS records near an iNat sighting are linked by distance and time.
- GOES cloud-masked and bad-quality pixels are stored with a flag and hatched, never filled from a neighbour.
- Satellite land temperature vs air temperature outside the expected offset is flagged as a conflict.
- Late records (ingested more than 24 h after observation) stay at their observed time and carry their ingest lag.
- Covered end to end in `gates/leaf-T27.md` and re-run after K1 (`gates/leaf-K1.md` G7: `QUALITY cases=5 shots=12`).

### Limits of the heuristic

`score = density × activity × access`, with hand-set multipliers (for example 0.3× activity below 15 °C). Density is normalised to each frame's maximum, so a score is relative within a frame, not absolute. The backtest is only as good as its sample: on a local database it once reported a 100% hit rate on 2 sightings, which means nothing. The fixture data has 8 sightings in the 7-day window (re-measured, `FIRSTLOAD … window=8 api=8 app=python`).

## Design choices in one paragraph each

The long form with alternatives and tradeoffs is `docs/design-alternatives.md`. Short version: one deployment and one engine for three apps, because the shared work (ingest, storage, evidence, timeline, agent, team features) is most of the system and the per-app part fits in config; SQLite per app with one writer thread and Litestream, because one process does all ingest and a €5 VM should run it; Rust for the data plane (long-lived push consumers, NetCDF decode, frame building across cores) and TypeScript for the agent, joined only by GraphQL over loopback; push where a provider offers it, poll with a rate governor everywhere else, and one signed webhook for anything delivered from outside; an explainable score with components instead of a model, because there are no labelled outcomes to train on.

## How it grows

The long form with numbers is `docs/scaling.md`. Short version: more apps are config plus adapters (carp for other states, lionfish for other regions); more data moves raw readings to columnar storage and frames to object storage behind a CDN; more traffic adds read replicas and queue-based ingest; more users per board moves from a WebRTC mesh (8 peers) to an SFU; more agent use needs per-tenant budgets. What to measure before each of those is in that file.

## Likely hard questions, with straight answers

**Is the score predictive?** No claim of that is made. Each app's score is a transparent heuristic, labelled as such. Python has a backtest (would yesterday's top 10% of cells have caught today's sightings, against a 10% random baseline) and its sample sizes are tiny. Lionfish reports thin regions as insufficient data. Carp makes no prediction at all: "needs review" means a rule fired on river data.

**Why not a trained model?** No labelled outcomes. Sightings are observer effort, not presence; removals with location and effort are the labels a model needs, and Inversa has those, not the public feeds.

**What would you do with Inversa's private data?** Removal records with location, time and effort become labels: catch per unit effort against conditions, per site. Operating areas replace the demonstration locations. Crew and equipment constraints become access rules. Body-cam and drone detections become one more sightings source with their own quality grade, flowing through the same evidence pipeline. The backtest harness is where a trained model would be compared to the heuristic.

**Is the agent accurate?** Grounding holds: in every final run of every app, every number in an answer traced to a tool output (`ungrounded=0`) and every boundary question was refused or caveated. Accuracy on the full benchmark, blind (the agent is never told which question it is answering), recorded 2026-10-01: carp 67, 69 and 65 of 69 in three final runs; lionfish 59, 62, 58 of 65; python 64, 64, 63 of 68 before K1 and 64 of 67 after it. Held-out sets: carp 41/42 twice, lionfish 36/40 and 34/40, python 31/36 and 30/36. The rubric's bar (95% overall and 90% per category, three runs in a row) is not met by any app. Most misses are wording a regex did not accept or a second tool not called; the failure analyses are in `docs/grading/agent-*-analysis.md`. Leaf J1 is replacing regex phrases with a judge and pooling runs; its results are not in yet.

**An earlier score was 69/69. What happened?** That run handed the agent each question's expected tools and wording. Blind, the same agent scored 62/69. The answer key was removed and a test now fails if any prompt or tool description contains a question id or pass phrase (`gates/leaf-AGB.md` G2).

**Why not Postgres and PostGIS?** One process writes; queries are bbox and time range; a second service doubles operations on a small VM. The limit is real and named in `docs/scaling.md`: past one writer's throughput or a few hundred GB, readings move out.

**Why three apps instead of one great one?** The brief asks for one question; each app has one. The engine is shared because most of the work is the same; the config seam is tested in both languages (`gates/leaf-A1a.md`, `gates/leaf-A1b.md`). The cost is breadth: each app got less polish than one would have.

**Why is it not deployed?** Deploying needs accounts and a push only a person can do (VM, DNS, R2, Doppler `prd`, the git push). The production build, health checks, rate limits, cost cap and restore drill are tested locally (`gates/leaf-H1.md`); the steps are in `docs/HUMAN_STEPS.md`.

**What is synthetic?** The carp review replay scene is synthetic and labelled. The python cold snap is real (NWS products from the IEM archive, Open-Meteo archive, USGS values for 30 January to 3 February 2026). Agent evals run against fixture GraphQL stubs built from recorded payloads, not the live API.

**What did the agentic tooling do, and what did you decide?** The build ran as a tree of tasks, each in its own git worktree with a gates file of runnable checks; contracts were fixed in `PLAN.md` before fan-out; a task counted as done only when its checks passed again on the merged tree. Gates that were ticked by a loose regex but missed their real bar are reported as not met (`gates/leaf-AGB.md` G1, `gates/leaf-AG2.md` G4 to G6).
