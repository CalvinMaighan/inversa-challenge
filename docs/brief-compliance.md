# Brief compliance

Every line of Inversa's brief (`docs/TASK_BRIEF.md`), checked for each app (carp, lionfish, python) and for the system as a whole. Re-audited row by row for leaf D1 on 2026-10-01, on branch `leaf/d1` (from `pivot/three-apps` at `18e8f16`).

**Update 2026-10-03:** the site is deployed (row 29). The UI has since been reduced to the map, the agent (text and hands-free voice), the Questions tab and the timeline: the Notes tab, team board and WebRTC panel are no longer shown, so rows that cite them describe code that is still in the repo but not on screen. The client-SQLite cache, SharedArrayBuffer threads and the frame replay (row 28, new technology) are still what the app runs on. Rows 11, 13 and 15 stay PARTIAL: GOES-19 and NWWS-OI need AWS and NOAA accounts, and `/api/health` shows each as disabled with the reason.

Status values:

- **MET**: built, and the gate or evidence file named in the row records it passing. Every MET row cites at least one `gates/*.md` or `docs/evidence/` path; `bun scripts/check-compliance-paths.ts` fails if a cited path does not exist.
- **PARTIAL**: built and working in part; the row says which part is missing and why.
- **ABANDON**: not done in this submission; the row says why.

"Live model" means `openai/gpt-6-luna` on OpenRouter with the key from Doppler `inversa/dev`. There is no mock model, and answers vary run to run. Benchmark numbers are the ones recorded in the gate files on 2026-10-01; leaf J1 (an LLM judge in place of regex phrases, plus pooled runs) is changing the eval while this is written, and its judged and pooled results will be added when it lands.

Re-measured for this audit (2026-10-01, `bun run check` in the D1 worktree): `CHECK-OK`; web 997 pass, active-state 96, signal-worker 37, active-theme 4, all 0 fail; API `cargo test` 365 passed, 0 failed, 5 ignored; `CRDT vectors passed: 19/19`. `bun scripts/check-questions.ts`: `QUESTIONS carp=69 lionfish=65 python=67 categories=10/10 ok`, `HOLDOUT carp=42 lionfish=40 python=36 ok`.

## The task

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 1 | A natural-language-driven interface for exploring a question about the physical and natural world | carp | `spec/apps/carp.json` (question: river and weather conditions at candidate carp-removal locations), carp tools in `apps/web/server/agent/tools/` | `gates/leaf-AG1.md` G7: `AGENT app=carp flow=ok`, 12 citation chips, drawer opened | MET (live model) |
| 2 | same | lionfish | `spec/apps/lionfish.json`, `apps/web/server/agent/tools/lionfish.ts` | `gates/leaf-AG2.md` G7: `AGENT app=lionfish flow=ok tools=3 citation=ok view=ok` | MET (live model) |
| 3 | same | python | `spec/apps/python.json`, `apps/web/server/agent/` | `gates/leaf-T14.md` G2 `FLOW-OK`; `gates/leaf-K1.md` G6: blind live run 64/67 after K1 | MET (live model) |
| 4 | One question per app, one engine | system | `spec/apps/{carp,lionfish,python}.json` validated by `spec/apps/app-config.schema.json` in Rust (serde) and TS (zod) | `gates/leaf-A1a.md` G1 (`app_config`), `gates/leaf-A1b.md` G1 (`app config`), G7 (`APPSELECT apps=3 …`) | MET |
| 5 | Following evidence to its source | system | `api/src/evidence.rs`, `api/src/source_pages.rs`, `apps/web/client/hud/drawer/` | `gates/leaf-E1.md` G1: every cited id kind resolves (forecast, reading, alert, review, hotspot, source, note, mission); `gates/leaf-T42.md` G2 to G7: publisher page per source, `EXTERNAL-LINKS` all in a new tab | MET |
| 6 | Following evidence to its source | carp | carp drawer and briefing (`apps/web/client/carp/`) | `gates/leaf-UC.md` G4: `CARP-EVIDENCE drawer=ok new_tab=ok stale=ok missing=ok cannot_assess=ok boundary=ok`; `docs/evidence/carp-drawer.png` | MET |
| 7 | Following evidence to its source | lionfish | priority card (`apps/web/client/lionfish/`) | `gates/leaf-UL.md` G2: `LIONFISH-CARD components=4 heat_both=ok field_separate=ok links_new_tab=ok no_percent=ok`; `docs/evidence/lionfish-priority-card.png` | MET |
| 8 | Following evidence to its source | python | evidence drawer, raw payload, publisher link | `gates/leaf-T42.md` G5; `gates/leaf-T41.md` G3 (`SPECIES … drawer=1`) | MET |
| 9 | Replaying change over time | (rows 16 to 19) | | | see rows 16 to 19 |

Row 9 has no status of its own; the timeline rows below carry it.

## Technical requirements

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 10 | Three or more relevant real-time data feeds organized around a coherent shared question | carp | USGS Water Data (OGC), NOAA NWPS, NWS alerts and gridpoint forecasts, IEM forecast archive: `api/src/ingest/poll/{usgs,nwps,nws,nws_forecast,iem}.rs` | `gates/leaf-C4.md` G6: `CARP-LIVE sites=8 usgs=8 nwps=8 nws=8 snapshots=72 iem=56` against the live APIs; `docs/evidence/carp-data-proof.md` | MET (polled feeds) |
| 11 | same, push half | carp | `api/src/ingest/push/nwws.rs` (NWWS-OI XMPP for LCH, LIX, SHV) | `gates/leaf-C4.md` G3: registered, reads DOWN with the missing-credential note | PARTIAL: NWWS-OI credentials pending (`docs/HUMAN_STEPS.md`; NOAA says approval can take 10 days or more). The `nws-alerts` poll covers alerts meanwhile |
| 12 | Three or more relevant real-time data feeds | lionfish | iNaturalist, GBIF, USGS NAS, NOAA Coral Reef Watch (ERDDAP), Open-Meteo Marine, NDBC | `gates/leaf-L4.md` G6: live 90-day backfill `LIONFISH-DATA fl=22 mx=24 bz=1 co=4`, equal to the iNat API counts; `gates/leaf-L3.md` G4: `CRW-LIVE regions=4 newest=2026-09-29`; `docs/evidence/data-proof.md` | MET (polled feeds) |
| 13 | same, push half | lionfish | GOES-19 `ABI-L2-SSTF` over SNS to SQS (`api/src/ingest/push/goes_sqs.rs`) | `gates/leaf-T7.md` G7 ABANDON (no SQS queue) | PARTIAL: GOES-19 push waits on an AWS account and queue (H4 in `docs/HUMAN_STEPS.md`); the decoder is tested on one recorded scan per product |
| 14 | Three or more relevant real-time data feeds | python | iNaturalist, USGS NAS, GBIF, NWS, USGS Water, NDBC, CO-OPS, Open-Meteo | `gates/leaf-T22.md` G3; `gates/leaf-T28.md`: 8 of 8 polled sources fetched within cadence + 2 min over 70 min against the live upstreams (`docs/perf.md`) | MET (polled feeds) |
| 15 | same, push half | python | GOES-19 LSTC, ACMC, FDCC, SSTF over SQS; NWWS-OI for MFL and KEY | `gates/leaf-T7.md` G7 ABANDON | PARTIAL: GOES and NWWS credentials pending (H4, NWWS-OI application). Both read DOWN with the reason, never hidden |
| 16 | Backend infrastructure for collecting, storing, and querying those feeds | system | one Axum binary (`api/`), one isolated SQLite pair per app under `<data dir>/<app>/`, GraphQL per app at `/v1/{app}/graphql` | `gates/leaf-A1a.md` G2 (`app_isolation`: a sighting written in one app is invisible to another's GraphQL, frames and hub), G3 (`app_routes`), G6 (`app_scheduler`); API 365 passed (re-measured) | MET |
| 17 | same | carp | bitemporal forecast store (`forecast_snapshots`, `forecast_points`), review engine (`api/src/review/`) | `gates/leaf-C3.md` G2 (`bitemporal_`), G5 (`FORECAST-PERF`, 60 days × 8 sites under 25 MB), `gates/leaf-C5.md` G2 (`review_asof_never_reads_future_rows`) | MET |
| 18 | same | lionfish | CRW adapter, four-area ingest, priority components (`api/src/hotspot/`) | `gates/leaf-L3.md`, `gates/leaf-L4.md`, `gates/leaf-L5.md` (all gates met) | MET |
| 19 | same | python | ingest, frames and hotspot scoring from the first build | `gates/node-data.md`; `gates/leaf-T11.md` G6 (frames benchmark) | MET |
| 20 | A web interface supporting natural-language queries across real-time and historical data | carp | `river_readings`, `river_forecast`, `forecast_verify`, `review_history` take times; `asOf` on every tool | `gates/leaf-AG1.md` G2 (`carp tool`, 23 pass), G7 ("what we knew" view event); `gates/leaf-AGB.md` G1: blind golden runs 67/69, 69/69, 65/69, `ungrounded=0` in all three | MET (live model) |
| 21 | same | lionfish | `sightings` with observed or submitted basis and `knownAt`, `reef_heat`, `marine_forecast` | `gates/leaf-AG2.md` G1 (`lionfish tool`, 17 pass), G4: blind runs 59/65, 62/65, 58/65, `ungrounded=0` | MET (live model) |
| 22 | same | python | `sightings`, `conditions`, `explain_cell`, `backtest` with `from`/`to` | `gates/leaf-AG2.md` G6: blind runs 64/68, 64/68, 63/68 before K1; `gates/leaf-K1.md` G6: 64/67 after K1, `ungrounded=0` | MET (live model) |
| 23 | Agent benchmark at the rubric's bar (blind, three runs in a row at 95% overall and 90% per category; held-out twice at 90%) | all three | `apps/web/eval/run.ts`, `spec/apps/questions/*.json`, `*.holdout.json` | `gates/leaf-AGB.md` G1 (carp: met in 1 of 3 final runs), `gates/leaf-AG2.md` G4 to G6 (lionfish typical 92%, python typical 94%); `docs/grading/agent-carp-analysis.md`, `agent-lionfish-analysis.md`, `agent-python-analysis.md` | PARTIAL: `ungrounded=0` and `boundary` 100% hold in every final run; the 95%/90% bars do not hold three runs in a row for any app. Leaf J1 (judge plus pooled runs) is in progress; its results will be added |
| 24 | An interactive timeline for visualizing and replaying changes over time | carp | stage timeline with forecast band, thresholds and the "what we knew" mode (`apps/web/client/carp/`) | `gates/leaf-UC.md` G2: `CARP-TIMELINE … scrub_median_ms=1.47`; G3: `CARP-ASOF forecast_swap=ok later_obs=ok board_asof=ok label=ok exit=ok`; `docs/evidence/carp-asof.png` | MET |
| 25 | same | lionfish | 30-day replay with "known at" semantics | `gates/leaf-UL.md` G4: `LIONFISH-REPLAY play=ok step=ok asof=ok scrub_median_ms=3.0 requests=0`; `docs/evidence/lionfish-replay.png` | MET |
| 26 | same | python | EVF2 frames in a SharedArrayBuffer, the cold-snap scene | `gates/leaf-T18.md` G2; `gates/leaf-H1.md` G6: `SCRUB median=7.51 requests=0 p95=13.87 … frames=96 verified=96`; `docs/evidence/cold-snap.png` | MET |
| 27 | Replay e2e lines the rubric asks for (`e2e:replay`, `e2e:feeds`, `e2e:evidence`) | all three | not written | `docs/grading/rubric.md` "What each later leaf must emit" | ABANDON in this leaf: those scripts belong to later leaves and do not exist on this branch; the per-app lines above (`CARP-TIMELINE`, `LIONFISH-REPLAY`, `SCRUB`) measure the same behaviour under other names |

## Deliverable requirements

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 28 | At least one meaningful part uses a technology new to the author | system | SharedArrayBuffer worker threads (`packages/active-state/src/threads/`), client SQLite on OPFS plus CRDT (`apps/web/client/threads/db/`, `apps/web/client/threads/crdt/`, `api/src/crdt.rs`), WebRTC data channels with a signal Worker on R2 (`apps/web/client/threads/rtc/`, `apps/signal-worker/`); `docs/new-technology.md` | `gates/leaf-T16.md` (10k messages over a real SAB ring), `gates/leaf-T19.md` G2 (`DBWORKER cached=0.4 opfs=1 proxy=1`), `gates/leaf-M1.md` G3 (`CRDT vectors passed: 19/19` both languages), G4 (`DM chars_streamed=40/40 p50_ms=26`), `gates/leaf-T21.md` | MET (the author confirms the "new to me" claim, rubric item `new-technology/claim-true`) |
| 29 | The finished demo must be deployed online and accessible through a shared URL | system | `deploy/` (Caddyfile, systemd units, Litestream, bootstrap, restore), `.github/workflows/` | `gates/leaf-H1.md` G2 (`e2e:prod`: `PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok` per app), G4 (`RESTORE-OK apps=3`); `gates/leaf-T6.md` G7 ABANDON | MET: live at https://inversa.bigvalue.lol (Hetzner, Caddy TLS, Cloudflare DNS). `GET /api/health` answers 200 for all three apps (`degraded` only names the optional feeds that need NOAA or AWS accounts). Deployed by `release.yml` on merge to main, then `deploy.yml` |

## What they are looking for

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 30 | A well-designed system with clear boundaries | system | one config contract read by Rust and TS; Axum is the only writer; the agent reaches data only through GraphQL; `PLAN.md` contracts C1 to C19 and C-A1 to C-A8 | `gates/leaf-A1a.md`, `gates/leaf-A1b.md` G4 (`app prefix`: every request carries `/v1/<app>/`), G5 (`agent per app`) | MET |
| 31 | Thoughtful data modeling | carp | four times kept apart: observed, issued, valid, ingested | `gates/leaf-C3.md` G1, G2 (`bitemporal_`) | MET |
| 32 | same | lionfish | observed vs submitted dates, GBIF copies linked to their iNat record, DHW and BAA kept as two values | `gates/leaf-L4.md` G2 (`lionfish_gbif_dedupe`), `gates/leaf-L3.md` G2 (`crw_quality`) | MET |
| 33 | same | python | readings with `flag` and `origin`, canonical ids for duplicates, revisions for ID flips | `gates/leaf-T7.md` G9, `gates/leaf-T9.md` G3, G4 | MET |
| 34 | Sensible architectural decisions | system | `docs/design-alternatives.md` | `gates/leaf-D1.md` G3; `gates/leaf-T11.md` G6 (EVF2 126,278 bytes per frame raw) | MET |
| 35 | A well-designed production agent that can interpret natural-language questions, use the available data and tools effectively | system | per-app persona, tool allowlist, scope guard and refusal text from config (`apps/web/server/agent/`) | `gates/leaf-A1b.md` G5 (`agent per app`, 12 pass); `gates/leaf-AGB.md` G2 (`no answer key`: no question id or pass phrase in any prompt) | MET |
| 36 | …and return reliable, grounded answers | all three | numbers must trace to tool output; citations stripped unless a tool returned the id | `gates/leaf-AGB.md` G1, G3 (carp `ungrounded=0`), `gates/leaf-AG2.md` G4 to G6 (lionfish and python `ungrounded=0` in every final run) | MET (grounding); accuracy is row 23 |
| 37 | Production limits | system | per-IP rate limit, per-app and global daily cost cap ($5 default), token and tool budgets | `gates/leaf-H1.md` G1 (`prod limits`, 12 pass), G2 | MET |
| 38 | A responsive, human-friendly interface | carp | board, briefing, bottom sheet at 375 px | `gates/leaf-UC.md` G5: `CARP-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok`; `docs/evidence/carp-mobile.png`, `docs/evidence/mobile/carp-375.png` | MET |
| 39 | same | lionfish | area chips, priority card, help panel | `gates/leaf-UL.md` G6: `LIONFISH-A11Y serious=0 critical=0 mobile_hscroll=0 keyboard=ok`; `docs/evidence/lionfish-mobile.png`, `docs/evidence/mobile/lionfish-375.png` | MET |
| 40 | same | python | chat column, legend, tooltips, help, phone sheet | `gates/leaf-T40.md` (18 met), `gates/leaf-T30.md` (axe 0/0); `docs/evidence/mobile/python-375.png` | MET |
| 41 | App selector | system | species icon button, popover, `?app=`, localStorage | `gates/leaf-A1b.md` G7 (`APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=19`), G9; `docs/evidence/appselect-dark.png` | MET |
| 42 | Makes the underlying data easy to explore and understand | carp | review board with reasons in words, "sources disagree" chips | `gates/leaf-UC.md` G1, G2; `docs/evidence/carp-board.png`, `docs/evidence/carp-timeline.png` | MET |
| 43 | same | lionfish | four components side by side, thin areas labelled, ocean-data help | `gates/leaf-UL.md` G1, G5; `docs/evidence/lionfish-help.png` | MET |
| 44 | same | python | species chip, evidence card, agent data panels | `gates/leaf-T41.md`, `gates/leaf-T38.md`; `docs/evidence/agent-panels.png` | MET |
| 45 | A fast experience in which queries feel interactive | carp | `apps/web/server/agent/cache.ts` (answer cache), db worker query cache | `gates/leaf-AGB.md` G5: first token p50 905, 959, 940 ms; re-measured for D1 (`gates/leaf-D1.md` G6): `PERF app=carp first_token_p50_ms=1123 n=5 cached_query_ms=6` | MET (under the rubric's 1,200 ms) |
| 46 | same | lionfish | | re-measured for D1 (`gates/leaf-D1.md` G6): `PERF app=lionfish first_token_p50_ms=1272 n=5 cached_query_ms=12`, then 1343 ms | PARTIAL: under the PRD's 2 s, over the rubric's 1,200 ms in both runs |
| 47 | same | python | | `gates/leaf-H1.md` G6 (p50 1092 ms on the full stack); re-measured for D1 with `e2e:perf --app python` (`gates/leaf-D1.md` G6): per-question first output p50 1566 and 1584 ms, and the repeated question missed the answer cache in both runs, so the script exits 1 | PARTIAL: over the rubric's 1,200 ms; answer-cache miss to fix |
| 48 | …and the timeline scrubs smoothly | all three | | `gates/leaf-UC.md` G2, `gates/leaf-UL.md` G4, `gates/leaf-H1.md` G6 (rows 24 to 26): scrub medians 1.47 ms (carp), 3.0 ms (lionfish), 7.51 ms (python), all with 0 requests, against a 16 ms budget | MET |
| 49 | High-quality data handling, including accurate real-time information | carp | USGS 15 min, NWPS versioned on `issuedTime`, NWS alerts 60 s with "checked at" when empty | `gates/leaf-C4.md` G1 to G3, G6; `gates/leaf-E1.md` G3 (empty polls recorded) | MET |
| 50 | same | lionfish | windows count by observed date; submitted date shown beside it | `gates/leaf-L4.md` G1, G6 (stored counts equal live iNat counts) | MET |
| 51 | same | python | feed-state envelope on every tool result | `gates/leaf-T28.md` (poll freshness 8/8), `gates/leaf-T27.md` | MET |
| 52 | Clear treatment of stale, missing, or conflicting data | carp | datum trap (KRZL1), Monroe flow disagreement, `cannot_assess` instead of `ok` when data is old | `gates/leaf-C5.md` G1 (`review_rule_forecast_category_datum_trap_krzl1`), G3 (`review_honesty_`); `gates/leaf-UC.md` G4; `docs/evidence/carp-data-proof.md` | MET |
| 53 | same | lionfish | stale CRW hatched with words, missing cells never zero, buoy vs satellite SST, thin areas, GBIF copies | `gates/leaf-UL.md` G3: `LIONFISH-QUALITY basis_toggle=ok late_filter=ok stale=ok missing=ok conflict=ok chips=ok`; `docs/evidence/lionfish-quality.png` | MET |
| 54 | same | python | stale chips, GOES cloud and bad-DQF cells, ID flips, LST vs air, duplicates, late records | `gates/leaf-T27.md` G1 to G3; `gates/leaf-K1.md` G7 (`QUALITY cases=5 shots=12`); `docs/evidence/quality/stale-drawer.png` | MET |
| 55 | Rubric's generic `e2e:quality --app` line | all three | `apps/web/e2e/quality.ts` takes no `--app` yet | `docs/grading/rubric.md` | ABANDON in this leaf: the per-app scripts above (`CARP-EVIDENCE`, `LIONFISH-QUALITY`, `QUALITY`) cover the cases; a unified `--app` script belongs to a later leaf |

## What we don't care about here

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 56 | No authentication, user accounts, permissions or identity management needed | system | none by design; no cookies; callsigns are local | `gates/leaf-H1.md` G3 (security pass: no cookies, text-only rendering, rate limits instead of accounts) | MET (nothing built, by design) |
| 57 | Not judged on test-coverage percentages or style-guide compliance | system | tests sit where logic is subtle; the grader scores behaviour lines, not coverage | `gates/leaf-G1.md` G3 (a check that prints nothing never earns points) | MET (no coverage target set) |

## Be prepared to answer questions about

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 58 | The question chosen, why it matters, why these data sources | carp | `docs/interview-notes.md` "Carp" | `gates/leaf-D1.md` G2; `docs/evidence/carp-data-proof.md` (L'CARP claims verified with URLs) | MET |
| 59 | same | lionfish | `docs/interview-notes.md` "Lionfish" | `gates/leaf-D1.md` G2; `docs/evidence/data-proof.md` | MET |
| 60 | same | python | `docs/interview-notes.md` "Python" | `gates/leaf-D1.md` G2 | MET |
| 61 | Major product and technical design choices, alternatives and tradeoffs | system | `docs/design-alternatives.md` (13 decisions) | `gates/leaf-D1.md` G3 | MET |
| 62 | How the system evolves with substantially more data, traffic, users or use cases | system | `docs/scaling.md` | `gates/leaf-D1.md` G4 | MET |
| 63 | Known gaps stated honestly | system | `docs/interview-notes.md` "Likely hard questions", this file's PARTIAL and ABANDON rows | every live-only gate carries an `ABANDON` line naming its human step, e.g. `gates/leaf-T7.md` G7, `gates/leaf-T6.md` G7, `gates/leaf-T17.md` G7 | MET |

## From the brief's welcome section

| # | Brief line | App | Where it is built | Evidence | Status |
|---|---|---|---|---|---|
| 64 | Use agentic AI tools while keeping ownership of the key decisions and the result | system | `PLAN.md` (contracts fixed before fan-out, status log of every merge), one gates file per leaf | `gates/leaf-K1.md` (driver re-ran each leaf's checks on the merged tree), `gates/leaf-AGB.md` G1 (a gate ticked by its regex was reported NOT MET on its own bar) | MET |
| 65 | Define the problem and choose where to focus time | system | `docs/research.md` (options and decisions), `docs/APPS.md` | `docs/evidence/data-proof.md` "Gaps and fallback" (thin areas kept and labelled rather than padded with feeds) | MET |
