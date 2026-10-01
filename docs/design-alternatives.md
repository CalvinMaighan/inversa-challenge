# Design choices, alternatives and tradeoffs

Thirteen decisions that shaped the system. Each section names the decision, the alternative or alternatives considered, the tradeoff, and why this choice won. Numbers are re-measured on 2026-10-01 for leaf D1 or quoted from the gate file named next to them.

## 1. One deployment with three apps on one engine

**Decision.** One Rust API process, one Next.js app and one agent runtime serve carp, lionfish and python. Each app is a JSON config in `spec/apps/` (question, feeds, regions or locations, score, layers, copy, agent persona and tool allowlist, helper questions, eval set), validated by one JSON Schema that Rust (serde) and TypeScript (zod) both load. The app is chosen at runtime by `?app=` in the URL.

**Alternative.** Three separate deployments, or three forks of the code, one per question.

**Tradeoff.** One engine means a change to ingest, evidence, the timeline or the agent runtime reaches all three apps at once, and a bug does too. Isolation has to be built rather than given by separate processes: each app gets its own SQLite files, hub, scheduler and frames builder inside one `AppRegistry`, and a test writes a sighting in one app and proves the others cannot see it (`gates/leaf-A1a.md` G2). Three deployments would isolate failures for free but triple the operations and let the copies drift.

**Why.** Most of the system is the same for every app: collecting, storing, citing, replaying and talking about feeds. The per-app part (which feeds, which score, which words) fits in config, and the config seam is enforced by tests in both languages (`gates/leaf-A1a.md` G1, `gates/leaf-A1b.md` G1, G5).

## 2. SQLite per app, one writer thread, Litestream to R2

**Decision.** Each app has `observations.db` and `team.db` under `<data dir>/<app>/`. One dedicated thread owns the write connection and batches commands into transactions; a pool of WAL readers serves queries. Litestream streams every file to R2 and `deploy/restore.sh` restores them on an empty disk.

**Alternatives.** Postgres with PostGIS, or TimescaleDB for the readings.

**Tradeoff.** Postgres buys concurrent writers, real spatial indexes and mature replication, at the cost of a second service to run, back up, upgrade and pay for on one small VM. SQLite's cost is one writer per file and no spatial index; queries here are bbox and time ranges, which plain B-tree indexes serve. The T4 concurrency test runs 8 writer and 8 reader tasks with no `SQLITE_BUSY` (`gates/leaf-T4.md` G2), and the restore drill restores all three apps from a local replica (`gates/leaf-H1.md` G4, `RESTORE-OK apps=3`).

**Why.** One process does all ingest, so one writer is not a bottleneck at this volume. Fixture databases measured for D1: carp 2.4 MB, lionfish 13.3 MB, python 1.8 MB. PostGIS is explicitly not used. The point where this stops working is named in `docs/scaling.md`.

## 3. Rust Axum for the data plane, TypeScript for the agent

**Decision.** Axum holds the long-lived push consumers (SQS long-poll, XMPP), the pollers, NetCDF/HDF5 decode of GOES scans, frame and hotspot building across cores with rayon, SQLite, GraphQL and the realtime hub. The agent and voice relay run in Next on Bun, because the agent harness reused (cordis) is TypeScript. They meet only at GraphQL over loopback.

**Alternative.** One Node or Bun backend for everything.

**Tradeoff.** Two runtimes to build, test and deploy, and two copies of a few contracts (the CRDT merge, the EVF2 frame reader), each held equal by shared golden vectors (`spec/crdt/`, `spec/frames/`). A single Node backend would avoid that, but would put HDF5 decode behind a native addon and the frame build on one JavaScript thread.

**Why.** The data plane is CPU work and long-lived connections; Rust handles both without a second process. The agent has no database access at all, which makes the boundary easy to audit.

## 4. GraphQL with WebSocket subscriptions instead of REST polling

**Decision.** Each app exposes `/v1/{app}/graphql` over HTTP and WebSocket (graphql-transport-ws). The client's gql worker subscribes to feed state, frame updates and team ops; the agent's tools are GraphQL queries. Bulk frames use one REST route, `GET /v1/{app}/frames`, because they are binary.

**Alternative.** A REST API with the client polling for changes.

**Tradeoff.** GraphQL adds a schema to keep in step (a test diffs the served SDL against `api/schema.graphql`) and a query language the agent tools must speak. REST polling would be simpler to cache at a CDN but would add latency and wasted requests for live feed state and team edits.

**Why.** One typed schema serves the UI, the agent tools and the subscriptions; new data (forecasts, reviews, reef heat) is a resolver, not a new endpoint family. The WebSocket path is also the durable fallback for team edits when WebRTC fails (`docs/perf.md`: WS edit p50 84 ms against a 1 s budget).

## 5. Push-first ingest with poll fallback

**Decision.** Use push where the provider offers it: GOES-19 through NOAA's SNS topic into an SQS queue, NWS products through NWWS-OI XMPP, and webhook nudges (IEMBot for NWS products, ERDDAP subscriptions for Coral Reef Watch) that make the poller fetch now. Everything else polls under a per-source rate governor that backs off on 429 and 5xx and honours `Retry-After`. Each poll row in `docs/ingest-modes.md` says why no push exists, with the provider's docs URL.

**Alternatives.** Poll everything on a timer; or the first plan, Cloudflare Cron Workers polling each feed and posting signed webhooks.

**Tradeoff.** Push needs accounts and long-lived connections: the SQS queue and the NWWS-OI login are still pending human steps, so GOES and NWWS read DOWN with a reason today. All-poll would work without accounts but cannot reach seconds of latency for alerts. Cron Workers lost on measured limits: the free plan gives 5 cron triggers and 10 ms of CPU per invocation, and GOES decode is CPU work.

**Why.** The brief asks for accurate real-time information. Where a provider offers push, it is the fastest and cheapest way to get it; where it does not, the poll is documented and its freshness is shown, not hidden. The 70-minute live poll run kept 8 of 8 sources within cadence plus 2 minutes (`gates/leaf-T28.md`).

## 6. A signed webhook and nudges instead of direct database writes

**Decision.** Anything delivered from outside the API lands through `POST /v1/{app}/ingest/hook/{source}`: the raw provider body, HMAC over the raw bytes, an idempotency key from the body hash, a size cap and a replay window. Nudges (`/v1/{app}/ingest/nudge/{source}/{token}`) carry no data; they only wake that source's poller.

**Alternative.** Let external jobs or scripts write to the database, or trust a third-party payload directly.

**Tradeoff.** Every external delivery pays for parsing through the same adapter the poller uses, which is slower than a bulk insert. A nudge costs one extra fetch from the provider. Direct writes would skip both, and would also skip validation, archiving of the raw payload and the idempotency check.

**Why.** One path in means one place to validate, archive and dedupe; a duplicate delivery answers 200 `duplicate` and writes nothing (`gates/leaf-E1.md` G4, 20 hook and nudge tests). A nudge cannot inject data because the payload is never trusted.

## 7. CRDT notes and messages over WebRTC instead of server-authoritative chat

**Decision.** Notes, missions, team chat, direct messages and removal counts are op-based CRDT records (HLC timestamps; last-writer-wins per field; HLC-ordered messages; a grow-only counter), applied locally in the same frame, broadcast to peers over WebRTC data channels, and persisted through the GraphQL `applyOps` mutation. Direct messages stream per keystroke over the data channel and commit as a CRDT message.

**Alternatives.** Server-authoritative chat over WebSocket only; or Yjs or Automerge.

**Tradeoff.** The custom CRDT exists twice (Rust and TypeScript), held equal by 19 shared vectors (`CRDT vectors passed: 19/19`, re-measured). Last-writer-wins drops one of two concurrent edits to the same field, which is wrong for prose, so free text lives in append-only messages. Server-only chat would be simpler and would lose optimistic offline edits. Yjs or Automerge bring a document model built for collaborative text that four small entity types do not need.

**Why.** Peer latency: per-keystroke DM p50 26 ms and live note edit p50 32 ms (`gates/leaf-M1.md` G4, G6), against a 100 ms target; edits to a peer p50 12 ms over RTC (`gates/leaf-T28.md`).

## 8. Bitemporal forecast snapshots and IEM backfill instead of live-only

**Decision.** For carp, every record keeps four times apart: observed, forecast issued, forecast valid, and ingested. Each NWPS issuance is a snapshot; the Iowa Environmental Mesonet archive backfills past issuances. "What we knew yesterday afternoon" queries the store as of that time and draws later observations separately.

**Alternative.** Store only the latest forecast and the observations.

**Tradeoff.** More tables and more rows (one snapshot per site per issuance), and as-of queries must filter on two times. The C3 test sized 60 days × 8 sites × 15 days of hourly points under 25 MB with as-of reads under 5 ms p95 (`gates/leaf-C3.md` G5). Live-only storage would be smaller and could never answer "what did we know then".

**Why.** NWPS keeps no forecast history (tested: its `issuedTime` and `asOf` parameters are ignored). Judging a past decision needs the forecast that existed then, not the one that exists now.

## 9. EVF2 binary frames and SharedArrayBuffer workers instead of per-frame queries

**Decision.** The timeline replays hourly binary frames (EVF2: u8 scores per taxon per region, i16 centi-°C temperature grids, 16-byte sighting records). The db worker caches them in SQLite and writes them into SharedArrayBuffer views; the globe reads those views directly.

**Alternative.** Query the API for each frame as the user scrubs, as JSON.

**Tradeoff.** A custom format needs a reader in each language and a golden file both decode (`spec/frames/sample.evf`), and cross-origin isolation headers (COOP and COEP `require-corp`), which forces third-party media through a same-origin proxy. Per-frame JSON would need none of that and would cost a network round trip and a parse per scrub step.

**Why.** Scrubbing makes no network request: python median 7.51 ms over 96 frames (`gates/leaf-H1.md` G6), lionfish 3.0 ms (`gates/leaf-UL.md` G4), carp 1.47 ms (`gates/leaf-UC.md` G2), against a 16 ms budget. EVF2 measured 126,278 bytes per frame raw against about 2.6 MB for the first float32 format (`gates/leaf-T11.md` G6).

## 10. A blind benchmark, with a judge coming, instead of hint-fed evals

**Decision.** The agent is evaluated blind: it gets the question, the view and its own rules, never the question id, expected tools or pass phrases. A test scans every prompt and tool description for leaks (`gates/leaf-AGB.md` G2). Each app has a golden set (69, 65 and 67 questions, re-measured) and a held-out set (42, 40, 36) written before the final tuning.

**Alternative.** The earlier harness handed the agent each question's expected tools and wording and checked the draft against the golden criteria before streaming.

**Tradeoff.** Blind scores are lower and noisier: carp went from 69/69 assisted to 62/69 blind before fixes, and final runs vary by several questions with the same code. The rubric's bars (95% overall, 90% per category, three runs in a row) are not met by any app yet. The assisted harness scored perfectly and measured nothing. Leaf J1 is replacing regex pass phrases with a judge model that must quote the answer, and pooling three runs, because per-category bars on 6 to 9 questions are noise; its results are not in yet.

**Why.** A benchmark that cannot fail tells Inversa nothing about the production agent.

## 11. Agent tools over GraphQL instead of text-to-SQL

**Decision.** The agent has a fixed set of tools per app (for carp: `site_status`, `river_readings`, `river_forecast`, `forecast_verify`, `review_history`, `weather_forecast`, `alerts`, `feed_state`, `source_info`, `evidence`, `notes`, `team_board`, `set_view`), each one GraphQL call returning values with units, sources, times, evidence ids and the feed-state envelope.

**Alternative.** Give the model the schema and let it write SQL.

**Tradeoff.** Tools must be designed and maintained per app, and a question no tool covers cannot be answered. Text-to-SQL would cover more questions with less code, and would hand a stochastic model a query language over raw tables, with no feed-state envelope, no units and no evidence ids to cite.

**Why.** Grounding: every number in an answer must trace to a tool output, and the final runs held `ungrounded=0` in every app (`gates/leaf-AGB.md`, `gates/leaf-AG2.md`). Tool shape matters: a per-feed parameter on `feed_state` made the model loop into the turn limit, and was reverted (`docs/grading/agent-lionfish-analysis.md`).

## 12. CesiumJS instead of MapLibre

**Decision.** A 3D globe (CesiumJS) with primitives, not Entities, and request-render mode so it idles.

**Alternative.** MapLibre GL with deck.gl: lighter and 2D-first.

**Tradeoff.** Cesium is a 4.7 MB module and a large static asset tree; ion's free Community plan has quotas and a commercial-use threshold, so the app falls back to keyless Esri imagery. First globe frame on the production build: 413 ms for python, 1,233 ms for carp and 1,555 ms for lionfish, software WebGL (`docs/perf.md`). MapLibre would load faster and render 2D rivers and reefs well.

**Why.** Half the geography is sea, and the lionfish areas span the Caribbean; a globe frames that honestly. Idle cost is 0 renders over 5 s (`gates/leaf-H1.md` G6). With hindsight, the carp app (river sites in one state) would be as well served by MapLibre.

## 13. Honest score components instead of a single risk number

**Decision.** Lionfish priority shows four components side by side (recent reports, ID quality, heat stress, data completeness), each with a value, a state (ok, unknown, stale) and its inputs. Carp shows "needs review" with reasons in words, or `cannot_assess` when data is old. Python shows each term of its score with the rule's rationale. No output field is named risk, probability, catch or abundance; schema tests enforce that (`gates/leaf-C5.md` G3, `gates/leaf-L5.md` G2).

**Alternative.** One "invasion risk: 87%" number per cell or site.

**Tradeoff.** A single number is easier to read and rank; components ask more of the user and the UI. The single number would also claim a probability the data cannot support.

**Why.** Reports measure observers, heat stress is context, and none of the feeds can say how many animals are there. The score has to show what it is made of so a user can disagree with it.
