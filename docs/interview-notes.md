# Interview notes

Prep for the four topics in Inversa's brief: the question and why it matters, the data sources, the design choices with their alternatives, and how the system grows. The last section lists what is not done. Every number here was measured on commit `81596be` or is quoted from a gate file, which is named.

## The question and why it matters to Inversa

> Where are Burmese pythons active and where should removal crews go next?

Since K1 (R14) this is one of three apps on one engine: carp (Louisiana river conditions), Lionfish Watch and Everglades Ops (python). Each tracks its own species only; see `docs/APPS.md`.

- Inversa removes invasive animals and sells the material: python and lionfish leather among others, and carp as "Silverfin". The removal pays for itself.
- It administers FWC's PATRIC python contractor program in the Everglades. FWC reported 235 removals in July 2024 and 748 in July 2025, with $2M of state funding (FWC release, 2025-10-21).
- It runs lionfish programs in Florida, Mexico, Belize and Colombia.
- Its product, Origin, sells a command center built on the loop "Invasive Hotspot, Initiating a Mission, Mission in Progress, Econ Metrics + ROI". Its feature list includes predictive heatmaps, geospatial alerts and a field app.
- The scientific advisor, Lily Xu, works on predictive patrol planning (PAWS, for anti-poaching). Expect questions on how the hotspot score is built and whether it predicts anything.

So I built a small Origin on public data, in their geography, for the Burmese python in South Florida and the Keys. (The first build also tracked two lizard species and lionfish on one map; the lizards were removed in K1 (R14), and lionfish became its own app.)

What the question forces the system to do:

- Join sightings, which say where animals were, with conditions, which say where animals are active and whether crews can work.
- Handle official alerts that change both overnight. A cold snap suppresses python activity and can kill pythons.
- Say where to go, which is a ranking. It has to be explainable and checked, or it is a guess with a colour ramp.

The other three options are in `docs/research.md` §4. A Caribbean lionfish dive planner had thin real-time signal outside the US. A Mississippi carp radar had the best physical signal, from 15-minute USGS gages, but carp barely appear in iNaturalist. Wildfire smoke had the richest data and nothing to do with Inversa. Lionfish and carp later became apps of their own on the same engine (`docs/APPS.md`).

## Why these data sources

| Source | What it answers | Why this one |
|---|---|---|
| iNaturalist | where animals were seen in the last minutes and days | the only live sighting stream with photos; research-grade IDs; ID changes after upload |
| USGS NAS | the curated record of non-native aquatic species | authoritative, weeks late: the history baseline |
| GBIF | deep history | mirrors iNat research-grade records days later, which makes the duplicate case real |
| GOES-19 ABI L2 | land and sea surface temperature, fire, cloud | satellite coverage of every cell, every hour, with real cloud gaps; offered as push through NOAA NODD |
| NWS, via NWWS-OI or `api.weather.gov` | freeze, cold, heat, marine and flood alerts | the official statement of conditions; NWWS-OI is push |
| USGS Water | Everglades stage and water temperature | water level concentrates prey and snakes, and decides airboat and levee access |
| NDBC and CO-OPS | buoy water temperature, wind, water level | in-situ truth to check satellite SST against |
| Open-Meteo forecast and marine | air temperature, wind, waves, 48 h forecast | keyless, hourly, a full historical archive; the cold-snap scene uses its archive API |

Every source except GOES-19 and USGS NAS is on the brief's sample list. I left out eBird, which has no python records, NASA FIRMS, because GOES FDCC covers fires, and aisstream, because vessel positions do not answer the question.

The mix of live, curated and lagged sources is deliberate. The same animal shows up in iNat, then in GBIF days later, then in NAS weeks later. An iNat ID can flip. A buoy and the satellite disagree about SST. Those are the brief's stale, missing and conflicting cases, on real data rather than synthetic fixtures.

## Major choices, alternatives and tradeoffs

The README's [Decisions](../README.md#decisions) section has the long form. Talking points:

- **Rust Axum for the data plane, Next on Bun for the conversation plane.** Axum holds long-lived push consumers (SQS long-poll, XMPP), CPU work (NetCDF decode, frames and hotspots across cores with rayon), SQLite, GraphQL and the realtime hub. The agent and the voice relay stay in TypeScript because the harness I reused (deedee's cordis and dsh packages) is TypeScript. The only coupling is GraphQL over loopback. The cost is two runtimes to build and deploy. A single Node backend was the alternative. It would have put HDF5 decode behind a native addon and the frame build, 1.5 ms per frame across cores in the T11 benchmark, on one JS thread.
- **Push where it exists.** GOES-19 through SNS into my SQS queue, NWS through NWWS-OI. Everything else polls under a rate governor with backoff and `Retry-After`. The first plan was Cloudflare Cron Workers posting signed webhooks, which lost on the free plan's limits of 5 cron triggers and 10 ms of CPU per invocation.
- **SQLite with one writer thread, plus Litestream to R2.** Cheap to run on a €5 VM, restorable from R2 with 1 s sync. The alternative was Postgres with PostGIS; it wins at many writers and at spatial queries, and costs a second service. The T4 gate runs 8 writer and 8 reader tasks with no `SQLITE_BUSY`.
- **EVF2 binary frames instead of JSON.** The first version stored f32 grids at 0.01°, about 2.6 MB per frame. EVF2 quantizes and uses coarser display grids: 126,278 bytes per frame raw in the T11 benchmark. The cold-snap scene came back as 121 frames in 553,336 bytes gzipped, about 4.6 KB per frame over the wire. The db worker writes frames straight into SharedArrayBuffer views, and the T18 gate measured a median scrub of 8.71 ms with 0 network requests.
- **GOES on a 0.05° grid.** At 0.01° the row count would blow past the daily budget. At 0.05° the fixture scan writes 7,232 rows, 173,568 a day, under the 250,000 cap the test asserts. Scoring still runs at 0.01°.
- **An explainable heuristic, not a model.** `score = density × activity × access`, with rule tables per species in `api/src/hotspot/rules.rs`, each rule carrying its rationale. A trained model needs labelled removal outcomes I do not have; Inversa does. The backtest panel reports the hit rate as measured, next to the 10 % baseline.
- **Grounded answers.** Each agent tool is one GraphQL call and returns `{kind, id}` evidence rows plus the feed-state envelope. The stream bridge removes any `[e:<id>]` citation that no tool returned in that turn. The eval sends 15 golden questions to the live model (`openai/gpt-6-luna` on OpenRouter, tools on a fixture stub) and checks tools, citation validity, citations per evidence kind and required phrases. Four runs scored 15/15, 15/15, 14/15 and 14/15, about $0.02 each; a live model varies run to run.
- **Voice through grok-voice with direct UI tools.** "Fly to Flamingo" is handled by Grok in one hop; analytic questions go to the cordis agent (GPT-6 Luna on OpenRouter) through `spawn_thinking`. The PRD target is 800 ms from end of speech to the globe moving. It has not been measured live (H6).
- **Op-based CRDT with hand-written merge rules.** LWW per field for missions and notes, HLC-ordered messages, a grow-only counter for removals, idempotent apply. Yjs or Automerge were the alternatives; the board has four entity types and simple rules, and 14 shared vectors keep the Rust and TypeScript copies equal.
- **WebRTC with signaling on a Cloudflare Worker and R2.** Free, stateless, and the server never sees app data. The cost is polling during the handshake and CAS retries on the peer list. Durable Objects are the upgrade.
- **CesiumJS.** A 3D globe with Google Photorealistic tiles over Miami and the Keys, idle rendering off (0 frames over 5 s idle, T17 G4). The costs are a large asset tree and ion's Community quotas; the app falls back to keyless Esri imagery.
- **A threaded client.** GraphQL and SQLite run on workers, synced to the main thread through a SharedArrayBuffer ring I added to my own `active-state` library as a `./threads` entry (19,467 bytes raw, 5,534 gzip, per its README). That needs cross-origin isolation, so COEP is `require-corp` and third-party media goes through a same-origin proxy (`/v1/media`).

## How it evolves

Following PRD §17, with the first step I would take for each:

- **More species or regions.** A region is a bbox, a taxa list and a rule table. Caribbean lionfish is the obvious next one, since Inversa runs that program; the marine rules exist. Mississippi carp needs a spawn rule (rising hydrograph and water over 18 °C) and the USGS adapter is already there. (Since done in another form: Lionfish Watch and a Louisiana carp conditions app now run as their own apps, `docs/APPS.md`.)
- **More data.** GOES alone can write 173,568 readings a day. Past a few months, split observations into monthly attached SQLite files, or send analytics to ClickHouse. Old frames become R2 chunks behind a CDN, with a rule to rebuild a chunk when late GBIF or NAS rows land in it.
- **More traffic.** Axum is stateless apart from the writer, so read replicas can run from Litestream followers. Voice sessions live in one Next process today; more web processes need sticky routing or a shared session store.
- **More users per board.** The mesh is capped at 8 peers. Past that, an SFU such as Cloudflare Realtime, and Durable Objects for signaling.
- **More use cases.** Inversa's body-cam and drone detections become one more sightings source with their own quality grade. Removal outcomes logged on missions become the labels a real model needs, and the backtest harness is the place to compare that model against the heuristic.

## Known limitations and honest gaps

State at `81596be`.

- **Not deployed.** The runbook, units, workflows and restore drill are written (`deploy/`), and nothing has run against real infrastructure. It waits on H1 (VM), H2 (DNS), H3 (R2 and TURN) and H8 (Doppler).
- **Live-only gates blocked on human steps**, each recorded as an `ABANDON` line in its gates file:
  - T5 G7, one object written to R2: H3.
  - T6 G7, the deploy and live URL checks: H1, H2, H3, H8.
  - T7 G7, one SQS message processed end to end: H4. GOES decode is tested on one real recorded scan per product, never on a live push.
  - T15 G7, spoken "fly to Flamingo" under 800 ms: H6.
  - T17 G7, ion imagery and Google 3D over Miami: H7. Only the keyless Esri rung has been seen rendering.
  - T20 G5, the signal Worker deployed on Cloudflare: H3.
- **The hotspot model is a heuristic.** The multipliers are hand-set, for example 0.3× for python activity below 15 °C. Density is normalized to each frame's maximum, so a score is relative to that frame, not absolute: the same cell at the same hour reads differently with only the cold-snap scene loaded and after `bun run data` adds the GBIF baseline. (The measured example here was a lizard cell, removed in K1 (R14).)
- **The backtest is only as good as its sample.** On my local database the python backtest over 14 days reported a 100 % hit rate: 2 sightings scored, a 10× lift that means nothing. The agent's answer states the sample size; the Backtest panel does not yet.
- **Team realtime is not in the app.** The CRDT (both languages), the ops mutation and subscription, the db worker's outbox and the signal Worker exist and pass their tests. The rtc worker and the Missions panel that tie them to the UI are T21, which has not landed.
- **The agent needs its key.** There is no mock mode. Without `OPENROUTER_API_KEY` (Doppler `inversa`), `/api/agent/stream` answers 503 `agent unavailable: OPENROUTER_API_KEY not set`. `bun run test` covers the non-model logic without secrets; `bun run test:live`, `bun run eval` and `e2e:agent` call the real model.
- **Quality, performance, accessibility and security passes are open.** T27 (data quality end to end in the UI), T28 (every PRD §13 latency target measured), T30 (accessibility and 375 px), T31 (security) and the integration nodes T23 to T26 have unchecked gates. Measured so far: scrub median 8.71 ms and p95 14.20 ms (T18), a cached client query in 0.4 ms (T19). First agent token, voice latency and edit-to-peer latency are unmeasured.
- **Doc drift.** `deploy/aws/README.md` says 5,713 GOES rows per scan and about 137k a day; the test on this commit prints 7,232 and 173,568.
- **GBIF paging.** GBIF's search API stalls past offset 10,000, so the baseline pages year by year (T22). The 5-year baseline was about 14,500 records before K1 narrowed it to the python, and takes most of `bun run data`'s time.

What I would do next, in order: let the timeline window move so the cold snap plays in the UI; land T21 so missions reach a second browser; get H1–H3 and H8 done and deploy; measure first-token and voice latency with real keys; show the backtest sample size in the panel.

When asked how agentic tools were used: the build ran as a tree of tasks, each in its own git worktree with a gates file of runnable checks (`gates/`, `PLAN.md`). The contracts in `PLAN.md` §C1–C16 were fixed before any task started, and a task counted as done only when its checks passed on the merged tree.
