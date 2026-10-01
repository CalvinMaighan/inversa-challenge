# Scaling: more data, traffic, users and use cases

How the system would change if it had to carry substantially more. Each section starts from what the system holds today, with numbers, then says what changes first at 10x and at 100x, and what to measure before deciding. "Re-measured" means measured again on 2026-10-01 for leaf D1; anything else names the gate or doc it comes from. "Not measured" means no number exists yet.

Today: one VM-sized process (Axum) serving three apps, each with its own SQLite pair, plus a Next.js process for the UI and agent, a Cloudflare Worker for WebRTC signalling, and Litestream to R2. It is production-ready and not deployed (`docs/HUMAN_STEPS.md`).

## Data

### What lands today

| Feed (app) | Volume | Source of the number |
|---|---|---|
| GOES-19 ABI L2 on 0.05° cells (python) | 7,232 rows per scan, 173,568 rows a day; the test asserts a 250,000 a day budget | re-measured: `cargo test goes_fixture_rows -- --nocapture` |
| Coral Reef Watch, four lionfish region boxes | 63,912 readings per product day, 1.5 MB of JSON, one product a day | `gates/leaf-L3.md` G4 (live) |
| USGS stage and discharge, 8 carp sites | 8,709 readings for 7 days, about 1,240 a day (15-minute values) | `gates/leaf-C4.md` G6 (live backfill) |
| NWPS forecasts, 8 carp sites | 1 issuance per site per day, 20 to 58 six-hourly points each | `docs/evidence/carp-data-proof.md` |
| iNaturalist | lionfish 0 to 5 updated records a day per area; python 4 in 24 h | `docs/ingest-modes.md` rows L1, P1 |
| Lionfish 90-day live backfill | inat 468 rows, NAS 4,086, GBIF 535 | `gates/leaf-L4.md` G6 |
| Frames | 721 hourly frames per species app (30 days plus one). EVF2 is 126,278 bytes per frame raw; stored compressed, the fixture frames average 1.1 KB (python) and 3.0 KB (lionfish) because the fixture grids are sparse | `gates/leaf-T11.md` G6; re-measured from fixture databases |
| Database files after `backfill --fixtures` | carp 2.4 MB (with WAL), lionfish 13.3 MB, python 1.8 MB; each `team.db` 52 KB; raw archive 0.2 MB, 7.3 MB and 7.3 MB | re-measured |

Live databases after weeks of polling have not been measured; GOES alone is the dominant writer for python, Coral Reef Watch for lionfish.

### At 10x (more regions, more GOES products, longer history)

1. **Readings move first.** At ten times the GOES or CRW volume one app writes millions of rows a day into one SQLite file through one writer thread. Split readings into monthly attached SQLite files (old months become read-only and easy to archive), or move readings to a columnar store (ClickHouse, or Parquet on object storage) and keep SQLite for sightings, forecasts, alerts and team data.
2. **Frames move to object storage.** Frames older than the live window are immutable except when a late GBIF or NAS record lands in them. Store them as chunks in R2 behind a CDN, with a rebuild-and-replace rule for chunks a late record touches. The client already fetches frames by time range, so only the URL changes.
3. **GOES decode spreads.** It already uses rayon across cores; next is several consumers on the same SQS queue, which SQS supports without coordination.

### At 100x

Postgres or ClickHouse for readings with sharded writers (by app, then by region or month); raw payloads only in object storage with lifecycle rules; frames built by a separate worker pool rather than the API process.

### Measure before deciding

Writer queue depth and transaction latency under the real GOES push; database growth per day per app; frame rebuild rate caused by late records; read latency of the as-of queries (`gates/leaf-C3.md` G5 sized 60 days × 8 sites at under 25 MB and under 5 ms p95).

## Traffic

### Today

The heavy path for a viewer is free: scrubbing reads frames from a SharedArrayBuffer with 0 requests (`gates/leaf-H1.md` G6). A cached client query takes 0.2 ms (`gates/leaf-T28.md`). Live updates come over one GraphQL WebSocket per tab. The agent route has a per-IP rate limit and a daily cost cap (`gates/leaf-H1.md` G1). The production build was load-tested only by the e2e runs, not under concurrent users: requests per second the API can serve are **not measured**.

### At 10x

1. **CDN for static assets and frames.** Cesium's 4.7 MB module and the frame chunks are cacheable; they dominate bytes per new viewer.
2. **Read replicas.** Axum holds no state apart from the writer, the hubs and the schedulers, so read-only API processes can serve GraphQL from Litestream replicas while one process ingests. Subscriptions then need a shared fan-out (below).
3. **Voice sessions** live in one Next process's memory; more web processes need sticky routing or a shared session store.

### At 100x

Regional read replicas behind the CDN; queue-based ingest (SQS or NATS) with idempotent workers instead of in-process pollers, since the signed hook already gives each payload an idempotency key; separate ingest and query processes per app.

### Measure before deciding

Requests per second and p95 per GraphQL query under load; WebSocket connections per process and memory per connection; cache hit rate on frames; agent requests per minute against the rate limit.

## Users

### Today

- Team boards are per app (`<app>:main`). Peers connect in a WebRTC mesh capped at 8 (`MAX_PEERS = 8` in `apps/web/client/threads/rtc/mesh.ts`). Measured latencies with two peers: edit to peer p50 12 ms over RTC, 84 ms over the WebSocket fallback (`gates/leaf-T28.md`); per-keystroke direct messages p50 26 ms (`gates/leaf-M1.md` G4).
- The WebSocket fan-out runs through Axum's per-app hub; how many subscribers one process holds is **not measured**.
- No accounts: callsigns are local, by the brief's own scope.

### At 10x

A mesh grows as n² connections, so past 8 peers on one board the next step is an SFU (Cloudflare Realtime or similar) and signalling on Durable Objects instead of R2 objects polled during the handshake. The WebSocket path stays as the durable copy.

### At 100x

Many boards per app (one per crew or area), authentication and permissions (out of scope for the brief, required for real crews), and the hub moved out of the API process to a pub/sub service so any API instance can serve any board.

### Measure before deciding

Peers per board in real use; messages per second per board; reconnect and resync rates; memory per WebSocket subscriber.

## Use cases

### Today

A new app is a config file plus adapters for any feed the engine does not have. Carp, lionfish and python all run this way: each config names its feeds, regions or locations, score components, layers, copy, agent tools and question set, and the scheduler starts only the feeds the config lists (`gates/leaf-A1a.md` G6).

### At 10x apps

- **Carp for other states.** A new state is new locations (USGS site, NWPS id, NWS grid per site) and the same five feeds; the C1 probe script (`scripts/probe-carp.ts`) is the template for checking coverage first. NWS offices change; the review rules do not.
- **Lionfish for other regions.** More region boxes in the config; the L1 probe (`scripts/probe-lionfish.ts`) decides keep, thin or cut per area before anything is built.
- **More species apps.** One taxon block per app; the hotspot and frame layouts are built from `regions[]` at runtime, not constants (`gates/leaf-A1a.md` G4, G5).
- **Inversa's own data.** Removal records, crew effort and drone or body-cam detections become sources with their own quality grades; removals with effort are the labels that would let a trained model be compared to the heuristics.

What does not scale by config alone: each app's agent tools and score engine (carp's review rules, lionfish's components) are code, and each app needs its own question set and benchmark runs.

### At 100x apps

A per-app config registry with versioning instead of files in the repo; per-tenant agent budgets and rate limits (today the cost cap is $2 per app and $5 global, `apps/web/server/agent/budget.ts`); data partitioned per tenant at the storage layer as well as by directory.

### Measure before deciding

Which parts of a new app were config and which were code; benchmark pass rate per app on its own held-out set before launch.

## Operations and cost

| Item | Today | Source |
|---|---|---|
| Agent cost per full benchmark run | carp about $0.20 for 69 questions, lionfish at most $0.26 for 65, python at most $0.21 for 67: roughly $0.003 to $0.004 per question at list price, most input tokens being prompt-cache reads | `docs/grading/agent-carp-analysis.md`, `docs/grading/agent-lionfish-analysis.md`, `docs/grading/agent-python-analysis.md` (2026-10-01; not re-measured in D1) |
| Agent first token | p50 over 5 live questions: carp 1,123 ms; lionfish 1,272 and 1,343 ms (two runs); python 1,566 and 1,584 ms (two runs, read from the per-question log because the script then failed: the repeated python question missed the answer cache both times). The rubric's bar is 1,200 ms, the PRD's 2 s | re-measured: `e2e:perf --app <id>` |
| Daily agent caps | $5 a day across all apps (`AGENT_DAILY_USD`), $2 per app (`AGENT_APP_DAILY_USD`), 100,000,000 tokens as a backstop (`AGENT_DAILY_TOKENS`); priced at $0.10/M input and $0.50/M output | `apps/web/server/agent/budget.ts`, `gates/leaf-H1.md` G1 |
| Hosting | one Hetzner CX22-class VM, R2 for raw archive and Litestream, a free-plan Worker | `deploy/README.md` (prices not re-checked) |

At 10x agent use the cost cap becomes the binding limit before the model's rate limits do; per-tenant budgets and an answer cache keyed by app, question and data version (which exists) are the levers. The open-data licences also matter at scale: Open-Meteo's free tier is non-commercial, and Cesium ion's Community plan has a revenue threshold; both need paid plans for commercial use (`docs/evidence/data-proof.md`, `docs/research.md`).
