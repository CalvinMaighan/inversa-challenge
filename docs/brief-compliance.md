# Brief compliance

Every line of Inversa's take-home brief, where it is built, what proves it, and its status at commit `81596be`. The driver re-verifies this table after the remaining leaves land.

Status values:

- **MET**: implemented, and the evidence named was checked for this table.
- **IN PROGRESS**: work remains in a named leaf.
- **BLOCKED**: waits on a human step from the README's H1–H10 list.
- **N/A**: the brief says it is not evaluated.

A row can carry two statuses when part of it is met and part is not. "Live model" means `openai/gpt-6-luna` on OpenRouter (key in Doppler `inversa`); there is no mock LLM, and the live eval varies run to run.

## The task

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 1 | A natural-language-driven interface for exploring a question about the physical and natural world | `apps/web/client/agent/` (orb, chat card), `apps/web/app/api/agent/stream/route.ts`, `apps/web/server/agent/` (cordis harness, tools), `docs/PRD.md` §1 | `gates/leaf-T14.md` G2: `FLOW-OK` (open the card, ask, tool rows, click a citation, drawer opens); `gates/leaf-T13.md` G3: live eval 14 to 15 of 15; G6: a live cited answer against the local API | MET (live model) |
| 2 | Uses three or more relevant real-time data feeds | `api/src/ingest/poll/{inat,nws,usgs,ndbc,coops,openmeteo,nas,gbif}.rs`, `api/src/ingest/push/{goes_sqs,nwws,hook}.rs` | `gates/leaf-T22.md` G3: release binary with no secrets fetched from the live pollers for about 95 s and `feeds` listed them; `gates/leaf-T32.md` G3: `feeds` after `bun run dev` showed CO-OPS lag 659 s and iNat lag 962 s | MET for the 8 polled feeds; GOES push BLOCKED on H4 (`gates/leaf-T7.md` G7 ABANDON) |
| 3 | Design the ingestion system | `api/src/ingest/scheduler.rs`, `api/src/ingest/archive.rs`, `api/src/ingest/governor.rs`, `api/src/ingest/push/hook.rs` | `gates/leaf-T5.md` G2 (governor backoff, 9 tests), G3 (HMAC hook, 7 tests), G4 (archive, fetch_run, ack after commit, idempotent re-run), G6 (supervised restart) | MET; R2 archive BLOCKED on H3 (`gates/leaf-T5.md` G7 ABANDON) |
| 4 | Design the storage system | `api/src/db/{writer.rs,pool.rs}`, `api/migrations/`, `deploy/litestream.yml`, `deploy/restore.sh` | `gates/leaf-T4.md` G2: 8 writer × 8 reader tasks, no `SQLITE_BUSY`; G8: a failing closure rolls back only itself; `gates/leaf-T6.md` G4: Litestream covers both databases | MET locally; replication and the restore drill BLOCKED on H1, H3 (T34) |
| 5 | Design the query system | `api/schema.graphql`, `api/src/graphql/`, `api/src/frames.rs` (`GET /v1/frames`), `api/src/evidence.rs` | `gates/leaf-T10.md` G2: 14 `resolver_*` tests; `gates/leaf-T4.md` G4: SDL matches `api/schema.graphql`; `gates/leaf-T11.md` G8: `frames_rest_route` | MET |
| 6 | A single interface for exploring questions in natural language | `apps/web/app/page.tsx` composes `Globe`, `Hud` and `AgentOrb` in one screen | `gates/leaf-T14.md` G2 `FLOW-OK`; `docs/evidence/t14-card-375.png` (live answer) | MET (live model) |
| 7 | Following evidence to its source | `api/src/evidence.rs` (record, raw payload, source URL, fetch time, ingest lag, links), `apps/web/client/hud/drawer/EvidenceDrawer.tsx`, `api/src/media.rs` | `gates/leaf-T10.md` G3: `evidence(id)` returns the raw payload and links for a sighting with a GBIF duplicate and a revision; `gates/leaf-T14.md` G2: a citation click opens the drawer | MET |
| 8 | Replaying change over time | `apps/web/client/hud/timeline/`, `api/src/frames.rs`, `apps/web/client/threads/db/`, `packages/active-state/src/threads/` | `gates/leaf-T18.md` G2: `SCRUB median=8.71 requests=0 p95=14.20 ... frames=96`; `docs/evidence/t18-gaps.png` | MET for the live 30-day window. IN PROGRESS, no leaf assigned: the UI clamps TIME to the last 30 days, so the cold-snap scene plays only through the API (`docs/demo-script.md` step 5) |

## Technical requirements

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 9 | Three or more relevant real-time data feeds organized around a coherent shared question | `docs/PRD.md` §1–2, `docs/research.md` §2 and §4 | Rows 2 and 25; `docs/interview-notes.md` "Why these data sources" | MET |
| 10 | Backend infrastructure for collecting, storing, and querying those feeds | `api/` (Axum, one binary) | `gates/node-data.md`: 4 of 4 met, including N3 `e2e_fixture_pipeline`; `gates/leaf-T32.md` G3: `cargo test` 205 passed, 0 failed | MET |
| 11 | A web interface supporting natural-language queries across real-time and historical data | Agent tools take `from`/`to` (`apps/web/server/agent/tools/capabilities.ts`); `backtest` scores past days | `gates/leaf-T13.md` G3: 15 golden questions, among them a 14-day backtest and live feed state | MET (live model) |
| 12 | An interactive timeline for visualizing and replaying changes over time | `apps/web/client/hud/timeline/Timeline.tsx` (scrubber, play, step, speed, live), `gaps.ts`, `alerts.ts` | `gates/leaf-T18.md` G2, G3; `docs/evidence/t18-gaps.png` | MET; cold-snap replay in the UI as in row 8 |

## Deliverable requirements

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 13 | At least one meaningful part uses a technology new to the author | SAB threads: `packages/active-state/src/threads/`; client SQLite and CRDT: `apps/web/client/threads/db/`, `apps/web/client/threads/crdt/`, `api/src/crdt.rs`; WebRTC signaling: `apps/signal-worker/` | `gates/leaf-T16.md` G3: 10k messages over a real Worker SAB ring in order; `gates/leaf-T19.md` G2: `DBWORKER cached=0.4 opfs=1 proxy=1`; `gates/leaf-T12.md` G2, G3: `CRDT vectors passed: 14/14` in both languages; `gates/leaf-T20.md` G3: `EXCHANGE-OK` | MET for SAB threads and client SQLite + CRDT. WebRTC in the UI IN PROGRESS (T21) |
| 14 | Deployed online at a shared URL | `deploy/` (Caddyfile, systemd units, bootstrap, restore), `.github/workflows/{release,deploy,workers}.yml` | `gates/leaf-T6.md` G1–G6 met (Caddyfile validates, isolation headers, units hardened, shellcheck clean) | BLOCKED on H1, H2, H3, H8 (`gates/leaf-T6.md` G7 ABANDON; T33) |

## What they are looking for

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 15 | A well-designed system with clear boundaries | `PLAN.md` §C1–C16 contracts; `docs/PRD.md` §5 "Boundaries"; `apps/web/eslint-plugins/` (`shared-purity`, `use-client-purity`, `source-areas`) | `gates/leaf-T4.md` G4 (schema contract test); `gates/leaf-T12.md` G2, G3 (one CRDT spec, two languages); `gates/leaf-T13.md` G5 lint `CLEAN` | MET |
| 16 | Thoughtful data modeling | `api/migrations/`, `api/src/model.rs`, evidence ids (`PLAN.md` §C14), readings `flag` and `origin` columns | `gates/leaf-T7.md` G9: readings upsert precedence; `gates/leaf-T9.md` G3, G4: dedupe links and ID-flip revisions | MET |
| 17 | Sensible architectural decisions | `README.md` "Decisions", `docs/interview-notes.md` | `gates/leaf-T11.md` G6: `BENCH frames 720 in 3.10s (126278 bytes/frame raw ...)`; `gates/leaf-T7.md` G8: `GOES rows/scan 7232 (rows/day 173568)` | MET |
| 18 | A production agent that interprets natural-language questions | `apps/web/server/agent/run-turn.ts`, `apps/web/server/agent/cordis/`, `apps/web/server/agent/prompt.ts` | `gates/leaf-T13.md` G1: unit and live suites pass; G4: every NDJSON line from the live model is a valid C7 event, ending with `done` | MET (live model) |
| 19 | Uses the available data and tools effectively | `apps/web/server/agent/tools/` (one GraphQL call per tool), agent limits in `run-turn.ts` | `gates/leaf-T13.md` G3: the eval checks that each golden question calls its expected tools | MET (live model); agent data panels and globe highlights IN PROGRESS (T38) |
| 20 | Returns reliable, grounded answers | `apps/web/server/agent/cordis/citations.ts` (strips citations no tool returned), `prompt.ts` (state staleness, conflicts, heuristic) | `gates/leaf-T13.md` G2: the citation checker strips an id no tool returned; G3 checks citation validity per question | MET (live model) |
| 21 | A responsive, human-friendly interface | `apps/web/client/hud/`, `apps/web/client/agent/morph/`, bottom sheets on phones (`MOBILE` in `apps/web/client/hud/primitives.tsx`) | `docs/evidence/t14-card-375.png` (card 375×480 inside a 375×812 viewport, `gates/leaf-T14.md` G3); `gates/leaf-T14.md` G4: reduced motion | IN PROGRESS (T30 accessibility and 375 px; T38) |
| 22 | Makes the underlying data easy to explore and understand | Evidence drawer, explain and backtest panels (`apps/web/client/hud/drawer/`), feed chips, detection brackets (`apps/web/client/hud/overlay/`) | `gates/leaf-T18.md` G1: `60 pass`; `docs/evidence/t17-globe.png`; `docs/evidence/t18-gaps.png` | IN PROGRESS (T38 agent data panels and globe highlights; T23/T24 integration) |
| 23 | A fast experience in which queries feel interactive | db worker cache (`apps/web/client/threads/db/`), answer cache (`apps/web/server/agent/cache.ts`) | `gates/leaf-T19.md` G2: cached query `0.4` ms | IN PROGRESS (T28: first agent token, voice and edit latencies unmeasured) |
| 24 | The timeline scrubs smoothly | EVF2 frames into SharedArrayBuffer views (`apps/web/shared/frames.ts`, `packages/active-state/src/threads/`) | `gates/leaf-T18.md` G2: median 8.71 ms, p95 14.20 ms, 0 network requests over 96 frames (target under 16 ms) | MET |
| 25 | Accurate real-time information | Live pollers, feed-state envelope (`api/src/feed_state.rs`), freshness fix for alert-only feeds (commit `7deb651`) | `gates/leaf-T22.md` G3; `gates/leaf-T4.md` G6: nominal, lagging, stale and down computed from `fetch_runs` (9 tests) | MET for polled feeds; GOES push BLOCKED on H4; NWWS push BLOCKED on H9 (optional, the NWS poll covers it) |
| 26 | Clear treatment of stale data | `api/src/feed_state.rs`, `apps/web/client/hud/topbar/feed-chips.ts`, the prompt rule in `apps/web/server/agent/prompt.ts` | `gates/leaf-T4.md` G6; `gates/leaf-T13.md` G3 (`EVAL quality passed 5/5`, re-run for `gates/leaf-T32.md` G3) | MET in the API, chips and agent; end-to-end UI check IN PROGRESS (T27) |
| 27 | Clear treatment of missing data | GOES cloud and bad-DQF rows (`api/src/ingest/push/goes_grid.rs`), timeline hatching (`apps/web/client/hud/timeline/gaps.ts`), "no data" explain terms (`api/src/hotspot/rules.rs`) | `gates/leaf-T7.md` G3, G9; `gates/leaf-T18.md` G3: `docs/evidence/t18-gaps.png` | MET; end-to-end UI check IN PROGRESS (T27) |
| 28 | Clear treatment of conflicting data | `api/src/ingest/quality_phys.rs` (SST satellite vs buoy, LST vs air), `api/src/ingest/quality_bio.rs` (iNat ID flips), drawer CONFLICTS badges | `gates/leaf-T8.md` G4: 4 conflict tests; `gates/leaf-T9.md` G4: ID flip gives a revision and a conflict flag | MET; end-to-end UI check IN PROGRESS (T27) |
| 29 | Duplicate and late data (beyond the brief's list; `docs/BUILD_BRIEF.md` R5) | `quality_bio.rs` (`canonical_id`), `api/src/hotspot/score.rs` (`FLAG_LATE`), `ingestLagSeconds` in `evidence.rs` | `gates/leaf-T9.md` G3; `gates/leaf-T10.md` G3 | MET; end-to-end UI check IN PROGRESS (T27) |

## What they do not care about

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 30 | No authentication, accounts or permissions needed | None, by design (`docs/PRD.md` §3, §4) | `docs/PRD.md` §4 non-goals | N/A |
| 31 | Test-coverage percentages and style-guide compliance are not evaluated | Tests go where logic is subtle (`docs/PRD.md` §4) | none needed | N/A |

## Be prepared to answer

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 32 | The question chosen, why it matters, why these data sources | `docs/interview-notes.md` first two sections, `docs/research.md`, `README.md` "Decisions" | `gates/leaf-T32.md` G1, G2 | MET |
| 33 | Major product and technical choices, alternatives and tradeoffs | `README.md` "Decisions", `docs/interview-notes.md` "Major choices" | `gates/leaf-T32.md` G1 | MET |
| 34 | How the system evolves with more data, traffic, users or use cases | `README.md` "Scaling", `docs/interview-notes.md` "How it evolves", `docs/PRD.md` §17 | `gates/leaf-T32.md` G1 | MET |
| 35 | Known gaps stated honestly | `docs/interview-notes.md` "Known limitations and honest gaps" | Every live-only gate has an `ABANDON` line naming its human step: T5 G7, T6 G7, T7 G7, T13 G6, T15 G7, T17 G7, T20 G5 | MET |

## From the brief's welcome section

| # | Brief line | Implemented in | Evidence | Status |
|---|---|---|---|---|
| 36 | Use agentic AI tools while keeping ownership of the key decisions and the result | `PLAN.md` (contracts fixed before fan-out, status log of every merge), `docs/BUILD_BRIEF.md`, `gates/` | `PLAN.md` status log; one gates file per task with runnable checks | MET |
| 37 | Define the problem and choose where to focus time | `docs/research.md` §4 (four options, one chosen), `docs/PRD.md` §15 cut order | `docs/research.md` §6 decisions | MET |
