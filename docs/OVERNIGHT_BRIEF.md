# Overnight brief: three apps on one engine (carp, lionfish, python)

## 0. Execution instruction

- **Target workspace:** `/Users/calvin/Documents/inversa-challenge` (branch `main`, remote `github.com/CalvinMaighan/inversa-challenge`, private).
- **Load `unlazy`** from `/Users/calvin/.claude/skills/unlazy/SKILL.md`. Read `references/orchestration.md` and the templates in `/Users/calvin/.claude/skills/unlazy/templates/`.
  - Checker: `node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 <gates-file>`. Always pass `--timeout`.
- **Read first, in this order:** `docs/TASK_BRIEF.md` (the graded brief, verbatim; evaluate everything against it), `docs/APPS.md`, `docs/LIONFISH_WATCH.md`, `PLAN.md` (the "Pivot: Lionfish Watch" section and the status log), `docs/PRD.md`, `docs/BUILD_BRIEF.md`, `docs/brief-compliance.md`, `/Users/calvin/.claude/CLAUDE.md` and `/Users/calvin/.claude/rules/*.md`.
- **Mode: orchestrated.** You are the driver. You plan, dispatch leaves as subagents with `isolation: "worktree"`, re-run their gates on the merged tree, merge, integrate. You implement only contracts, the app-config seam skeleton, and integration nodes. Every verification pass is yours.
  - `model: "fable"` for novel high-risk leaves: A1 (app seam), C3 (bitemporal forecast store), C4 (NWPS adapter), L5/C6 (score engines).
  - `model: "opus"` for pattern-port leaves: adapters, UI, agent prompts, evals, docs.
- Use lean-ctx `ctx_*` tools, terse output, the YAGNI/minimal-code ladder. Never skip validation, security or error handling.
- **Do not** push, deploy, publish, send email, create accounts or enter credentials. Work on local branches; merge leaf branches into a local integration branch `pivot/three-apps`, not `main`, until the user says so. Commit locally with the attribution line the harness provides. Human-only steps are blockers: write them to `docs/HUMAN_STEPS.md` and continue elsewhere.
- Never print or commit secret values. Secrets live in Doppler `inversa/dev` and GitHub Actions secrets.
- **Overnight rules:** work until the ledger is full or blocked. Log progress by appending one line per merged leaf to the `PLAN.md` status log. If credits or time run out, write remaining work into the gates files as unchecked boxes with reasons, so the morning session can resume. Do not stub, narrow scope silently or report done on unchecked gates.
- L1 is done (6 of 6). Do not edit `scripts/probe-lionfish.ts` or `docs/evidence/data-proof.md`. Its findings override earlier assumptions in this brief: NAS is not Florida-only, CRW comes from ERDDAP, thin areas stay visible.

## 1. Goal

Ship one deployed-ready product at `inversa.calvinmaighan.dev` that serves **three apps** on one engine, chosen by a species icon button popover in the HUD:

1. **Carp** (Louisiana): default app. Field conditions explorer for an operations manager.
2. **Lionfish Watch**: survey prioritization in four areas (Florida Keys, Mexican Caribbean, Belize, Colombian Caribbean).
3. **Python** (Everglades): the existing build, kept working as a config.

Each app is vertically integrated: its own question, feeds, score, agent persona, helper questions, eval benchmark and copy. All three must satisfy `docs/TASK_BRIEF.md`: 3+ relevant real-time feeds around a shared question, ingestion/storage/query backend, natural-language web interface across real-time and historical data, interactive timeline with smooth replay, deployed online, a technology new to the author, a grounded production agent, fast interactions, careful stale/missing/conflicting data handling, and the ability to defend question, design tradeoffs and scaling.

## 2. Requirements

- **R1** App selector: a species icon button in the HUD opens a popover listing carp, lionfish, python (icon, name, one-line question, feed-health dot). Selection lives in the URL (`?app=<id>`), default `carp`, remembered per viewer in localStorage, carried by share links, replays and agent view state. Keyboard accessible, Escape returns focus, external links open in a new tab.
- **R2** App config seam: one `AppConfig` unit (id, taxa or program, areas/locations, feeds, score components and weights, rules, agent persona, helper questions, eval set, copy, map preset, layers). No app-specific literal outside config. Python and lionfish share the species model; carp uses the location/conditions model.
- **R3** Data isolation: one deployment, one SQLite file per app under `INVERSA_DATA_DIR/<app>`, same schema. Pollers, frames, GraphQL, agent tools, WebRTC rooms and the share link are keyed by app id.
- **R4** Scope guard: each app refuses out-of-scope species, areas or locations, naming what it covers.
- **R5** Lionfish Watch per `docs/LIONFISH_WATCH.md`: lionfish only, four areas, feeds iNaturalist + NOAA Coral Reef Watch (new adapter) + Open-Meteo Marine (+ GBIF deduped against iNat, NAS Florida-only, buoys and GOES SST as conflict cases), transparent priority components (recent reports, ID quality, heat stress, completeness), no single risk percent, honesty rules shown in UI and agent, 90-day window.
- **R6** Carp app per `docs/APPS.md`: Louisiana demonstration river locations, feeds USGS Water + NOAA NWPS (new adapter) + NWS alerts/forecasts, per-location "Needs review" with reasons and sources, map + timeline + chat + evidence drawer + location briefing.
- **R7** Bitemporal replay (carp hero feature): every record keeps observation time, forecast issuance time, forecast valid time and ingestion time. "Show me what we knew yesterday afternoon" renders yesterday's forecast version; later observations appear separately to score the forecast. Forecast and alert snapshots are retained from first ingest and the UI states where replay coverage begins.
- **R8** Python app: the existing Everglades behaviour (T1–T44) is preserved under the python config; its gates still pass.
- **R9** Agent benchmark per app: golden set with categories (lookup/filter, time compare, explain-why, data relevance and sources, data quality, planning, refusals/boundaries), at least 5 cases per category for lionfish and carp, python keeps its existing 15. Pass bar: no ungrounded numbers, no stale data narrated as live, no causal or abundance claims, every number traces to a cited source row. Live eval run via Doppler `inversa/dev` against real OpenRouter calls (no mock agent).
- **R10** Ocean-data relevance: the lionfish agent and a UI help panel explain what SST, SST anomaly, degree heating weeks, waves and currents mean for survey planning, why each feeds the score, with sources and limits.
- **R11** Performance holds: timeline scrub median < 16 ms with 0 requests, first token p50 about 1 s, no regression of `docs/perf.md` rows; app switch under 500 ms warm.
- **R12** Docs: `README.md`, `docs/PRD.md`, `docs/brief-compliance.md` (re-audited against `docs/TASK_BRIEF.md`), `docs/demo-script.md`, `docs/interview-notes.md` updated for three apps, each with defended alternatives and a scaling story.
- **R13** Existing stack kept: WebRTC, WebSockets, GraphQL, active-state, web workers, SQLite. PostGIS is not adopted.

## 3. Verified context

- Rust API: `api/src/` (`model.rs`, `state.rs`, `backfill.rs`, `evidence.rs`, `frames.rs`, `realtime.rs`, `graphql/`, `hotspot/{rules,score,backtest}.rs`, `ingest/poll/{inat,gbif,nas,usgs,nws,ndbc,coops,openmeteo,physical,bio}.rs`, `ingest/push/{goes_*,hook,nwws}.rs`). Species literals (tegu etc.) appear in: `hotspot/*`, `evidence.rs`, `graphql/query.rs`, `backfill.rs`, `frames.rs`, `ingest/poll/{inat,gbif,nas,bio}.rs`, `ingest/push/hook.rs`.
- Web: `apps/web/client/{globe,hud,state,threads,agent,voice}`, `apps/web/server/agent/{prompt.ts,tools/*,runtime,run-turn.ts}`, `apps/web/eval/{golden.ts,run.ts,views.ts}`, `apps/web/shared/`. Species literals in: `client/globe/species.ts`, `client/hud/{tooltip/model.ts,help/content.ts}`, `server/agent/{prompt.ts,tools/evidence.ts,tools/capabilities.ts}`, `server/voice/voice-prompt.ts`, `shared/{frames.ts,voice/ui-tools.ts}`, `eval/golden.ts`.
- HUD already has `client/hud/species` and `client/hud/topbar`; the selector popover belongs near them.
- Gates: `gates/leaf-T*.md`, `GATES.md`, e2e scripts `apps/web/e2e/*.ts` with `bun run e2e:<name>` in `apps/web/package.json`. Root scripts: `bun run check`, `bun run eval`, `bun run test:api`, `bun run data`.
- Existing bbox is South Florida 24.3N–27.5N, 83.2W–79.8W (`docs/PRD.md` §Region). Lionfish half-life 60 d in the old score; the old score is `density × activity × access` (`docs/PRD.md` §Hotspots).
- `docs/PRD.md` line about extension already names Caribbean lionfish as a config-only extension.
- The carp research (L'CARP launch May 2026, April 2026 commission agenda, Origin wording) comes from ChatGPT and is **unverified**. Do not state it as fact in any doc until verified with a source URL; mark it "reported, unverified" otherwise.
- NWPS has no general forecast archive; replay coverage starts at our first snapshot (source: the same research, **verify** against the NWPS API docs in C1).
- Unknown until measured: lionfish data density per area (L1), Louisiana gauge coverage and NWPS forecast availability (C1), whether GOES-19 sectors cover Belize/Colombia (L1), CRW access method and licence (L1).

## 4. Proposed solution

- Add an `AppConfig` registry on both sides (Rust `api/src/app/` and TS `apps/web/shared/apps/`), defined from one JSON/TOML schema that both read, so config cannot drift. The Python app is the first config extracted from the current hard-coded values; lionfish and carp are added after the seam exists. Add `app` to every GraphQL query, REST route, WebSocket subscription, frame key, agent tool call and share-link payload.
- Partition storage by app with one SQLite file per app and one writer pool each; pollers are scheduled per enabled app. The shared schema gets a `forecast_snapshots` table (carp) with the four times in R7; observations tables are untouched.
- Carp score is not a hotspot: a per-location "needs review" rule set (stage rise rate vs threshold, forecast crossing flood category, active alert, stale or missing input) with each reason carrying its source and issuance time. Lionfish score reuses the hotspot grid with the new four components. Python score unchanged.
- Agent: one runtime, per-app prompt, tool allowlist, scope guard and golden set, selected by app id. Reuse cache, budget, feed-state envelope and citation machinery unchanged.
- UI: one shell; the app config picks map preset, layers, legend, helper questions and copy. The selector is a popover like existing chrome popovers (see `client/hud/topbar`).
- Alternatives rejected: three deployments (user wants one domain with a selector); PostGIS (stack is SQLite plus Rust, no gain in 72 h); copying the codebase per app (drifts).

Scope boundaries: no auth, no new accounts, no deployment, no push. Python disabled code paths removed from the lionfish and carp builds only through config, not deletion.

## 5. Tasks (all unchecked)

Waves run in order; leaves inside a wave run in parallel worktrees. After each wave the driver merges, re-runs every leaf's gates on the merged tree, and runs `bun run check`.

### Wave 0: contracts and proof (driver + L1)

- [ ] **A0** Write the pivot contracts into `PLAN.md` (extend P1–P4): `AppConfig` schema, `app` parameter on GraphQL/REST/WS/frames/agent/share link, per-app data dir layout, forecast snapshot schema, file ownership per leaf. Reqs R2, R3, R7. Acceptance: contract section reviewed, schema file `spec/apps/app-config.schema.json` exists, a schema-validation test in both Rust and TS loads the same sample config. Evidence: both tests green.
- [x] **L1** Lionfish data proof. DONE 2026-10-01, 6 of 6 gates (re-run by driver), results in `docs/LIONFISH_WATCH.md` "L1 results"; gates in `gates/leaf-L1.md`. Reqs R5. Acceptance: `docs/evidence/data-proof.md` with recommended bboxes and keep/thin/cut verdicts, 4 `AREA`, 4 `CRW`, 4 `MARINE`, 4 `COVER` lines from the probe. Dependents wait on it.
- [ ] **C1** Carp data proof (same shape as L1): `scripts/probe-carp.ts`, `docs/evidence/carp-data-proof.md`. Pick 5–8 Louisiana river sites by checking that USGS gauges (stage and discharge), NWPS forecasts (stage/flow, flood categories) and NWS forecast zones all exist; record the NWPS snapshot cadence, API limits, and confirm or refute "no archive". Optional: iNaturalist carp counts. Reqs R6, R7. Acceptance: probe prints `SITE <id> usgs=<ok> nwps=<ok> nws=<ok>` for each chosen site, doc lists final sites with coordinates and flood-category thresholds, and the doc gives source URLs verifying or refuting the L'CARP claims in §3. Gates in `gates/leaf-C1.md`.

### Wave 1: app seam (fable)

- [ ] **A1** App-config seam in Rust and TS. Extract python's literals (taxa, bbox, rules, half-lives, copy, helper questions, agent persona, eval set) into `apps/python` config; load by `app` id; thread `app` through GraphQL schema (`api/schema.graphql`), REST, WS, frames keys, agent tools, share link, WebRTC room names. Per-app SQLite files and per-app pollers. Reqs R2, R3, R4, R8. Owns: `api/src/model.rs`, `state.rs`, `app/**`, `graphql/**` signatures, `apps/web/shared/apps/**`, share-link modules. Acceptance: with only the python config, the full existing suite passes unchanged (`bun run check` and `cargo test`), a test proves queries without `app` default to `carp` or fail with a typed error as the contract says, and a cross-app leakage test proves python data is invisible to a second dummy app. Gate file `gates/leaf-A1.md`.
- [ ] **A2** Species/app selector popover (UI). Reqs R1. Owns `apps/web/client/hud/appselect/**`, `client/state/app.ts`. Acceptance: e2e `bun run e2e:appselect` prints `APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms<500`; axe scan 0 violations; screenshots in light and dark and mobile 375 px looked at, saved under `docs/evidence/appselect-*.png`. Depends on A1 contract only (stub the registry).

### Wave 2: lionfish (opus unless noted; after L1 and A1)

- [ ] **L2** Lionfish config: four areas with L1's bboxes, preset camera, species/taxa, legend, copy, helper questions, map layers. Reqs R5. Acceptance: config validates; app switch to lionfish flies to the Florida Keys preset; four area chips fly to each area.
- [ ] **L3** NOAA CRW adapter `api/src/ingest/poll/crw.rs` + `api/fixtures/crw/**`: SST, anomaly, DHW/bleaching alert level at 5 km daily, raster to the app grid, feed-state, quality flags (stale daily product, missing cell, cloud/land mask). Reqs R5, R10. Acceptance: fixture-driven cargo tests named `crw_*` pass, one live ignored test passes, source page and licence recorded in `source_pages.rs`.
- [ ] **L4** Lionfish ingest re-pointing: iNat introduced lionfish in the four bboxes (observed vs created dates kept), GBIF deduped to iNat by id, NAS Florida only with an explicit "not covered here" state elsewhere, Open-Meteo Marine waves and currents, buoy SST vs CRW conflict case, 90-day backfill, `bun run data` for lionfish. Reqs R5. Acceptance: tests `lionfish_ingest_*`; `bun run data` for the app leaves per-area counts within 10% of the iNat API counts (quote both).
- [ ] **L5** (fable) Lionfish priority score `api/src/hotspot` for the lionfish config: components (recent reports, identification quality, heat stress, data completeness) returned separately, configurable weights, field conditions kept separate, transparent labelled heuristic, backtest panel kept. Reqs R5. Acceptance: tests `lionfish_score_*` assert components are returned individually and no single percent field exists; `explainCell` returns observation ids, CRW cell values, timestamps and links.
- [ ] **L6** Lionfish UI: Lionfish Watch branding, four-area presets, evidence card (observation, CRW cell, timestamps, source links), honesty banner copy ("sightings are not abundance"), ocean-data help panel (R10), timeline replays CRW and sightings. Reqs R5, R10. Acceptance: e2e `e2e:lionfish` prints `LIONFISH areas=4 evidence=ok honesty=ok help=ok`; screenshots looked at.
- [ ] **L7** Lionfish agent and benchmark: prompt, tools allowlist, scope guard (R4), golden set of at least 40 cases (8 categories × 5 as in `docs/LIONFISH_WATCH.md`), live eval. Reqs R4, R9, R10. Acceptance: `bun run eval -- --app lionfish` prints `EVAL pass=<n>/<n>` with all categories passing in three consecutive live runs; a lint-style test fails if an answer contains a number not present in tool results. Quote the EVAL lines.

### Wave 3: carp (after C1 and A1)

- [ ] **C2** Carp config: chosen sites, Louisiana map preset, layers, legend, "demonstration locations" wording, helper questions, copy. Reqs R6.
- [ ] **C3** (fable) Bitemporal forecast store: `forecast_snapshots` and alert snapshot tables, ingest keeps issuance, valid time and ingestion time, queries `asOf(t)` return the forecast version issued at or before t, and a forecast-vs-observation comparison. Reqs R7. Owns migration, `api/src/db/**`, `api/src/frames.rs` additions, GraphQL `asOf`. Acceptance: tests `bitemporal_*`: two forecast versions for one valid time return different values for different `asOf`; an observation arriving after `asOf` is excluded from that view and included in the later one; coverage-start field exists.
- [ ] **C4** (fable) NWPS adapter, USGS Water re-point (stage, discharge, history backfill), NWS forecast and alerts snapshots for the sites; feed-state; snapshot scheduler at the cadence C1 found. Reqs R6, R7. Acceptance: fixtures plus live-ignored tests `nwps_*`, `usgs_la_*`, `nws_la_*`; after one local run the DB holds at least two forecast snapshots per site (quote the SQL count).
- [ ] **C5** Carp "needs review" engine: rule set per R6/§4, reasons with source and issuance time, missing or stale input produces "cannot assess", feeds the briefing. Reqs R6. Acceptance: tests `needs_review_*` covering each rule, stale, missing and conflicting (gauge vs forecast) cases.
- [ ] **C6** Carp UI: location map with freshness, timeline with observed vs forecast bands and a visible "replay coverage begins" marker, "what we knew" mode toggle, evidence drawer (readings, units, timestamps, issuance times, links), location briefing card. Reqs R6, R7. Acceptance: e2e `e2e:carp` prints `CARP sites>=5 asof=ok drawer=ok briefing=ok coverage_marker=ok`; scrub median < 16 ms.
- [ ] **C7** Carp agent and benchmark: prompt, tools (`asOf` aware), scope guard, golden set of at least 40 cases including "Show me what we knew yesterday afternoon", "Which locations have the largest rise in river stage over the last 24 hours?", "Compare these two locations for tomorrow morning", "Why did this location start needing review?", boundary refusals (abundance, catch, access, trip safety). Reqs R4, R7, R9. Acceptance: same bar as L7.

### Wave 4: python and integration

- [ ] **P1** Python as a config: confirm every T1–T44 gate still passes under `app=python`, move any remaining literals into config, python helper questions and copy. Reqs R8. Acceptance: `bun run eval -- --app python` still at the leaf-T39 threshold (15 cases), `e2e:firstload`, `e2e:species`, `e2e:links` pass with `?app=python`.
- [ ] **X1** Three-app integration: run all three apps from one local stack; app switching (URL, localStorage, share link, agent view state, WebRTC rooms), per-app data isolation, scope guards, feed-health dots in the selector, replay in each app. Reqs R1, R3, R4. Acceptance: e2e `e2e:apps` prints `APPS switch=ok isolation=ok share=ok rooms=ok guards=ok`.
- [ ] **X2** Performance and accessibility pass: re-run `docs/perf.md` rows per app, axe over each app, keyboard walk, mobile 375 px screenshots (looked at). Reqs R11. Acceptance: perf table updated with measured numbers; axe 0/0 for all three apps.
- [ ] **X3** Deploy readiness (no deploy): update `deploy/**` and `.github/workflows` for per-app data dirs and per-app pollers, Litestream per app file, Caddy unchanged domain; list the human steps in `docs/HUMAN_STEPS.md`. Reqs R3. Acceptance: `bash -n` on scripts, `docker`/systemd unit review, a dry-run of the build script (`bun run build`) succeeds; nothing is pushed or deployed.
- [ ] **D1** Docs re-audit (R12): rewrite `docs/brief-compliance.md` row by row against `docs/TASK_BRIEF.md` for each app (MET, PARTIAL, ABANDON with reason), update `README.md`, `docs/PRD.md`, `docs/demo-script.md` (a 5-minute path through all three apps), `docs/interview-notes.md` (why each question, alternatives, tradeoffs, scaling story: more apps as config, more areas, sharded writers, object storage for frames, queue-based ingest). Remove any unverified claim about Inversa. Acceptance: every claim in `brief-compliance.md` cites a gate file or evidence path that exists (a script checks that each cited path exists).

### Final integration node

- [ ] **Z1** On `pivot/three-apps`: `bun run check`, `cargo test --manifest-path api/Cargo.toml`, `cargo clippy --all-targets -- -D warnings`, every `gates/leaf-*.md` and `gates/node-*.md` through gate-check, live evals per app, all `e2e:*` scripts, `bun run build`. Acceptance: ledger N of N with every number re-measured; ABANDON lines surfaced with reasons. Do not merge to `main`.

## 6. Verification and gate procedure

1. Before any implementation write `GATES.md` entries or per-leaf `gates/leaf-<id>.md` using `/Users/calvin/.claude/skills/unlazy/templates/gates-leaf.md`; internal nodes use `gates-node.md`. Convert each acceptance line above into outcome gates with runnable `CHECK:`/`EXPECT:` where possible; discover real commands from `apps/web/package.json` and `api/Cargo.toml` first, never invent them.
2. Dispatch each leaf as a fresh subagent whose brief is the contract plus its gates file only. After it returns, you re-run its checks yourself with `--status` and spot-run the CHECK commands. Send back leaves with unmet gates named.
3. Live LLM checks use `doppler run -p inversa -c dev --` against real OpenRouter calls. No mock agent. If Doppler or the network is unavailable, mark the gate ABANDON with the reason and continue.
4. Screenshots listed in gates must be looked at, and the finding stated in the evidence line.
5. Report format (also written to `docs/OVERNIGHT_REPORT.md` at the end): gate ledger `N of N`, per-leaf status, every ABANDON with reason, human steps needed, EVAL lines per app, perf numbers, branch name and last commit hash. Re-measure every count before stating it; label anything not re-measured "unverified".
6. Stop conditions: all gates met with evidence, or a clean handover with remaining work written as unchecked gates. Do not describe abandoned work as completed.

## 7. Open questions (defaults assumed; do not block on them)

- **Q1** Carp site list: default is 5–8 sites chosen by C1 from real gauge/NWPS/NWS overlap in Louisiana. Confirm with the user in the morning.
- **Q2** If an area has too little lionfish data, default is to mark it "thin" and keep it visible with an honest empty state, not cut it.
- **Q3** Python's current bbox and rules are unchanged.
- **Q4** Default app is carp; if the user wants the existing python build to remain the landing view, flip `defaultApp` in config.

## 8. Added at goal time (2026-10-01): production scope

Supersedes §2 where it conflicts.

- **R14 Only three apps exist.** Carp (default), lionfish, python. All other species (tegu, iguana, plants, generic "other" taxa, categories popover) are removed from UI, agent, data and eval, not just disabled. Feeds, pollers, websockets and fixtures that serve none of the three apps are removed.
- **R15 Push first.** For each feed use a push or webhook mechanism if the provider has one (GOES-19 SNS to SQS, NWWS-OI, NWS alert streams, Firecrawl or provider webhooks where real); a feed is polled only when it is rich, useful and frequent and has no push API. Every poll vs push choice is justified in `docs/ingest-modes.md` with the provider's docs URL. All ingest lands through the signed `/api/ingest/:source` hook (HMAC) or a documented poller; websockets fan out to clients.
- **R16 Questions list.** `docs/questions.md` lists every chat question each app supports (grouped by the benchmark categories), each with expected tools, expected evidence and pass criteria; it is the source for the golden set and for the helper questions in the UI.
- **R17 Real-time messaging.** WebRTC data channels carry (a) direct messages between viewers with **per-character streaming** (every keystroke delta appears on the peer as typed, with edit/backspace and a typing-ended commit), and (b) live note edits that merge in real time (CRDT) with peer cursors/presence. Per-app rooms. Messages and notes persist via the existing CRDT/DB path. Gates measure latency (p50 under 100 ms local) and convergence.
- **R18 Benchmark grading system.** `bun run grade` runs one command that scores the whole submission against `docs/TASK_BRIEF.md`: a rubric file `docs/grading/rubric.md` with weighted criteria taken from the brief's "technical requirements", "what we're looking for" and "be prepared to answer", each tied to automated checks (agent evals per app, e2e, perf, a11y, data-quality cases, live-URL smoke if deployed) and manual evidence items; output `docs/grading/report.md` with per-criterion score and evidence paths. Pass bar: every criterion at or above its threshold; total at least 90 of 100.
- **R19 Production-ready, not deployed.** Build, systemd/Caddy/Litestream, env docs, health endpoints, rate limits, error handling, cost caps are complete. Deploy and push need explicit user authorization; list them in `docs/HUMAN_STEPS.md`.

### Added tasks

- [ ] **F1** Feed audit and push/poll plan (Wave 0, opus): `docs/ingest-modes.md` for every feed of the three apps. Acceptance: table feed, app, mechanism (push/webhook/poll), cadence, why, provider URL; every poll row says why no push exists.
- [ ] **Q1** Questions list (Wave 0, opus): `docs/questions.md` per R16, at least 40 per app. Acceptance: a test parses it and checks category coverage and unique ids; golden sets import from it.
- [ ] **M1** (fable) WebRTC messaging: per-character DM streaming and real-time notes, per-app rooms, presence. Owns `apps/web/client/threads/rtc*`, `client/hud/{notes,missions}`, `packages/active-state` threads, `apps/signal-worker`. Acceptance: e2e `e2e:dm` prints `DM chars_streamed=ok p50_ms<100 backspace=ok persist=ok`; e2e `e2e:notes` prints `NOTES live_edit=ok converge=ok presence=ok`; CRDT vectors pass in both runners.
- [ ] **K1** Cleanup of dropped species/feeds (R14) after A1, across the files listed in §3. Acceptance: grep for the removed literals returns zero in `api/src apps/web/client apps/web/server apps/web/shared apps/web/eval`; all gates updated or ABANDONed with reason.
- [ ] **G1** Grading system (R18). Acceptance: `bun run grade` exits 0 and writes `docs/grading/report.md` with total >= 90 and every criterion >= threshold; each rubric row cites a runnable check or an existing evidence file.
- [ ] **H1** Production hardening: health, rate limits, cost cap, error budgets, security review pass (`docs/security.md` update). Acceptance: `bun run e2e:prod` passes for all three apps.
