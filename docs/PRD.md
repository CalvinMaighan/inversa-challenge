# Everglades Ops: PRD

Inversa take-home. Status: v3, 2026-09-30. It supersedes v2: the backend moves to Axum, ingest is push-first, the agent runs on DeepSeek through cordis, voice runs on grok-voice, and the UI is app-first.

Research and decisions: [research.md](research.md).

- **Deploy target:** https://inversa.calvinmaighan.dev
- **Deadline:** 72 h. Sized as about 2 weeks (10 working days) for one senior developer; agent tooling (Claude, Cursor) runs the work in parallel.

## 1. Problem

The brief asks for:
- a natural-language interface over three or more real-time physical-world feeds;
- a backend that collects, stores and queries them;
- evidence traceable to its source;
- a replayable timeline;
- a public URL.

At least one meaningful part must use technology new to the author.

The brief does not prescribe how ingest works (push or poll). It asks only for "backend infrastructure for collecting, storing, and querying those feeds", "accurate real-time information", and "clear treatment of stale, missing, or conflicting data". Where a source offers push, we take it (section 6).

### The question

**"Where are invasive species active across South Florida right now, and where should removal crews go next?"**

Why this question, for Inversa:

- **It is their work.** Inversa runs FWC's python contractor program (PATRIC) in the Everglades: 235 removals in July 2024, 748 in July 2025. It also runs lionfish programs in Florida and the Caribbean.
- **It mirrors their product.** Origin is an AI command center built around the loop *hotspot → mission → mission in progress → ROI*.
- **It needs several feeds.** Four priority invaders share one map across land and sea: Burmese python, Argentine tegu, green iguana and lionfish.
  - Sightings say where animals were.
  - Conditions (land surface and air temperature, water stage, sea state) say where they are likely active and whether crews can work.
  - Official alerts change both overnight: a cold snap stuns iguanas and kills pythons.

### Region and species

- **Bbox:** 24.3°N–27.5°N, 83.2°W–79.8°W.
- **Focus taxa:** *Python bivittatus*, *Salvator merianae*, *Iguana iguana*, *Pterois volitans/miles*.
- **Background layer:** all iNaturalist observations flagged `introduced=true`.

## 2. Data feeds

| Feed | Mode | Gives | Cadence | Role |
|---|---|---|---|---|
| GOES-19 ABI L2 via NOAA NODD | **Push**: SNS `NewGOES19Object` → our SQS queue | Land surface temp (LSTC), SST (SSTF), fire detections (FDCC), clear-sky mask (ACMC) | 5–60 min | Satellite conditions; clouds create real gaps |
| NWS via NWWS-OI (XMPP) | **Push** once account approved | Freeze, heat, marine and flood products | Seconds | Official conditions |
| NWS alerts API | Poll 60 s (`If-Modified-Since`) | Same, as CAP JSON | 1 min | Fallback until NWWS-OI is approved |
| iNaturalist API v1 | Poll 2 min (`updated_since`, 1 req/s) | Observations, photos, quality grade, ID changes | Minutes | Live sightings |
| USGS Water Data (IV) | Poll 15 min | Everglades stage, gage height, water temp | 15 min | Habitat state |
| NOAA NDBC + CO-OPS | Poll 6–10 min | Buoy water temp and wind; water level | 6–60 min | Marine truth vs satellite and model |
| Open-Meteo forecast + marine | Poll hourly | Air temp, rain, wind, wave height; 48 h forecast | Hourly | Forecast windows for missions |
| USGS NAS API v2 | Poll daily | Curated nonindigenous records | Daily, lags weeks | Authoritative history |
| GBIF occurrence API | Poll daily | Deep history; includes iNat research grade | Daily, lags days | History and duplicates |

**Push notes:**
- The NODD SNS topic accepts only SQS and Lambda subscribers. An SNS payload filter on `Records.s3.object.key` prefix keeps just our four products, well inside the SQS free tier. Axum long-polls the queue, fetches the NetCDF object from the public `noaa-goes19` bucket, and reads only the bbox window.
- The NWWS-OI request goes to `NWWS.Issue@noaa.gov` on day 1. Approval can take up to 10 days, and the NWS alerts API poll covers the gap.
- The generic signed webhook endpoint (`/v1/ingest/hook/:source`) takes anything else that can push. Firecrawl monitors watching FWC program pages are a stretch goal.

**Quality cases built in:**
- The same animal can appear in iNat, then GBIF, then NAS, weeks apart.
- An iNat identification can change after ingest.
- Satellite skin temperature and station air temperature disagree.
- Satellite SST and buoy readings disagree.
- Cloud-masked pixels are missing, and buoys and gages drop out.

## 3. Users and flows

There is no auth (per the brief). Each viewer picks a callsign and a colour, stored locally.

The app is full screen: a CesiumJS globe under a tactical HUD. There is no side menu and no app-shell chrome.

1. **Ask by voice or text.** An agent orb sits in the bottom-right corner.
   - Hold or tap the orb to talk (grok-voice).
   - Click it and it morphs into a small chat card with the transcript, streamed answers, tool timeline and citations.
   - Grok answers fast UI requests itself ("fly to Flamingo", "show last Tuesday", "hide buoys"). It hands analytic questions to the DeepSeek agent and speaks the result when it returns.
2. **Follow evidence.** A citation (in the card, or a detection bracket on the globe) opens the evidence drawer. It shows the normalized record, the raw payload as fetched (from R2), the source URL, fetch time, feed state, and any duplicate or conflict links.
3. **Replay.** Scrub up to 30 days in 15-minute frames along the HUD's bottom edge. Sightings, hotspots, satellite LST/SST and alert bands animate. Cloud gaps and feed outages render hatched and are never interpolated.
4. **Hotspot to mission.**
   - Any heatmap cell becomes a mission, carrying its species, window, conditions and evidence.
   - Missions live in a collapsible HUD Missions panel shared by the team: status goes planned → in progress → done, crews log removals, and the panel shows totals.
   - Team chat sits in the same panel.
5. **Real-time collaboration.** Mission edits and chat are optimistic locally and reach peers over WebRTC. The server keeps the durable copy.

## 4. Non-goals

- Auth, accounts, permissions.
- A validated ecological model. Hotspots are an explainable heuristic, labelled as one, with a backtest panel.
- Post-process shaders (FLIR/NVG/CRT).
- Coverage targets. Tests go where logic is subtle: feed normalization, GOES pixel windowing, dedupe, CRDT merge, SAB ring, hotspot scoring, the agent loop against a mock LLM.

## 5. Architecture

```
 Browser ────────────────────────────────────────────────────────────────────────────
  main: React HUD + CesiumJS globe · agent orb/card · RTCPeerConnection shell
        AudioWorklet mic (16 kHz PCM16 up) · playback (24 kHz PCM16 down)
    ▲ SharedArrayBuffer rings + Atomics (@calvinjs/active-state/threads)
    ▼
  gql worker: GraphQL HTTP + graphql-transport-ws    db worker: sqlite-wasm OPFS, CRDT, frame cache
  rtc worker: transferred RTCDataChannels ◄──── P2P (TURN fallback) ────► peers
 ─────────────┬──────────────────────────────┬───────────────────────────────────────
              │ /v1/*  (GraphQL, WS, media)  │ /api/agent/*, /api/voice/*  (NDJSON)
 Hetzner VM   ▼  Caddy: TLS, COOP/COEP       ▼
  api: Rust Axum (tokio multi-thread)         web: Next.js 16 on Bun
    ingest: push (SQS, XMPP), pollers           UI (SSR shell, static assets, Cesium)
    SQLite: 1 writer thread + read pool         agent: cordis + dsh harness → DeepSeek (Fireworks)
    frames + hotspots (rayon)                   voice: grok-voice relay (xAI realtime WS)
    GraphQL (async-graphql), realtime Hub       tools ──► api /v1/graphql (localhost)
    R2 archive (raw payloads)
  litestream ──► R2
 ────────────────────────────────────────────────────────────────────────────────────
 AWS (free tier): SQS queue subscribed to NODD SNS NewGOES19Object (filtered)
 Cloudflare (free tier): signal Worker + R2 (WebRTC rendezvous, 1-day lifecycle)
                         R2 buckets: raw, litestream, signal
```

### Why this split

- **Axum owns the data plane.** That covers long-lived push consumers (SQS long-poll, XMPP), CPU-heavy work (NetCDF decode, frame building, hotspot grids across all cores with rayon), SQLite, GraphQL and realtime fan-out. It is multi-threaded where it matters, and it copies big-value's `api/` skeleton.
- **Next on Bun owns the conversation plane:**
  - The agent runs on deedee's cordis / dsh harness (npm `@deepseek-ai/cordis` + `@deepseek-ai/dsh-*`, TypeScript).
  - The voice relay runs grok-voice, with sessions held in memory in a single process.
  - Their tools call Axum's GraphQL over localhost. That is the only coupling.
- **The signal Worker relays SDP and ICE only.** It never sees app data.

### Boundaries

- The Axum ingest module is the only writer to observation tables. The Axum GraphQL layer is the only writer to team tables (ops).
- Every agent tool call goes through GraphQL. The agent has no database access.
- Only the client db worker touches client SQLite.
- CRDT logic exists twice, in Rust (`api/src/crdt.rs`) and TypeScript (client). Shared golden vectors in `spec/crdt/*.json` must pass on both.
- Hotspot scoring exists once, in Rust. The client only renders grids.

### Repo layout

Conventions:
- big-value for Axum (`api/`), deploy, CI, `client/state`, `Providers.tsx`, and the ESLint plugin.
- deedee for the agent (`server/agent-platform/cordis/*`), chat primitives (`client/ui/chat/*`), voice (`client/voice/*`, `server/voice/*`, `shared/voice/protocol.ts`), and morph (`client/ui/modal/morph/*`).

```
api/                          Rust crate inversa-api (axum 0.8, async-graphql 7, rusqlite bundled, tokio)
  src/main.rs app.rs state.rs
  src/db/{writer.rs,pool.rs}  migrations/000N_*.sql
  src/graphql/{query.rs,mutation.rs,subscription.rs}
  src/ingest/{scheduler.rs,archive.rs,quality.rs}
  src/ingest/push/{goes_sqs.rs,goes_grid.rs,nwws.rs,hook.rs}
  src/ingest/poll/{inat.rs,nws.rs,usgs.rs,ndbc.rs,coops.rs,openmeteo.rs,nas.rs,gbif.rs}
  src/hotspot/{rules.rs,score.rs,backtest.rs}
  src/{frames.rs,crdt.rs,realtime.rs,media.rs,feed_state.rs}
  tests/  fixtures/
apps/web/                     Next.js 16 App Router on Bun, output: standalone
  app/                        / (ops), /api/agent/stream, /api/voice/**
  client/globe/               Cesium viewer, layer contract, imagery ladder, render governor
  client/hud/                 top bar, feed chips, timeline, detection brackets, evidence drawer, missions panel
  client/agent/               orb, morph card, chat stream (deedee NDJSON reader + tool timeline)
  client/voice/               mic-capture, pcm, audio-uplink, playback, barge-in, voice-runtime
  client/threads/             boot.ts, gql.worker.ts, db.worker.ts, rtc.worker.ts
  client/state/  client/themes/  client/ui/Providers.tsx
  server/agent/               cordis boot, cordis.yml, limits, stream-bridge, capability tools
  server/voice/               grok-realtime, voice-session(s), voice-prompt, ui tools
  shared/voice/protocol.ts    shared/agent/events.ts
apps/signal-worker/           Cloudflare Worker: rendezvous over R2 + TURN credential mint
packages/active-state/        git subtree of CalvinMaighan/active-state + ./threads
packages/active-theme/        git subtree, @calvinjs/active-state import fix
spec/crdt/                    golden vectors shared by Rust and TS
deploy/                       Caddyfile, systemd units, litestream.yml, bootstrap.sh
docs/                         PRD, research, ADRs, demo script
```

## 6. Ingestion (Axum)

`ingest/scheduler.rs` spawns one tokio task per source, supervised: the task restarts with backoff when it panics or errors. Each task produces raw payloads.

Every payload goes through the same path:

1. **Archive:** gzip-compress, then put to R2 at `raw/{source}/{yyyy}/{mm}/{dd}/{id}`, and record `raw_objects`.
2. **Normalize:** a pure `fn(&[u8]) -> Vec<Row>` per source, tested against recorded fixtures.
3. **Write:** send the rows to the writer thread. The writer batches them into one transaction, upserts idempotently on `(source, ext_id)`, and records a `fetch_run`.
4. **Mark dirty:** the affected frames are flagged. The frame builder (rayon) runs after a 5 s debounce and publishes `framesUpdated` on the Hub, which reaches GraphQL subscribers.

Source-specific behaviour:

- **GOES push (`goes_sqs.rs`, `goes_grid.rs`):**
  - SQS long-poll (20 s), then an S3 key, then an HTTPS GET from `noaa-goes19`.
  - The `netcdf` crate (static feature) reads the variable window covering the bbox. The window is precomputed once from the GOES fixed-grid projection, and cells are aggregated to the 0.01° app grid.
  - Pixels flagged cloudy or with bad DQF are stored as missing, not dropped.
  - The SQS message is deleted only after the write commits.
- **NWWS-OI (`nwws.rs`):** an XMPP MUC client (`tokio-xmpp`) filtered to the Miami and Key West WFOs. It is enabled when credentials exist; otherwise `nws.rs` polls.
- **Rate governor:** each poller follows God's Eye View's OpenSky proxy pattern:
  - a minimum interval per source;
  - on 429 or 5xx, the interval doubles up to a cap, honouring `Retry-After`;
  - the governor state feeds `feed_state.rs`.
- **Backfill:** `inversa-api backfill --days 30`, plus 5 years of NAS and GBIF as a baseline, plus the GOES archive for the replay fixture.

### SQLite in Axum

- **Writer:** one dedicated writer thread owns the write connection and takes commands over an mpsc channel. It groups batches into transactions and replies with oneshot channels. The async threads never block on the write lock.
- **Reads:** a pool of N read connections (WAL), used through `spawn_blocking`.
- **Pragmas:** WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`. big-value's migration runner (`include_str!` + `schema_migration`).
- **Databases:** `observations.db` and `team.db`, both replicated by Litestream to R2 (1 s sync).

## 7. Data model

### `observations.db`

```
sources          id, name, homepage, mode(push|poll), cadence_s, max_latency_s
fetch_runs       id, source_id, fetched_at, received_at, status(ok|empty|error|partial),
                 http_status, rows_in, raw_object_id, error
raw_objects      id, r2_key UNIQUE, source_url, fetched_at, bytes, sha256
taxa             id, scientific_name, common_name, focus
sightings        id, source_id, ext_id, taxon_id, lat, lon, accuracy_m, observed_at,
                 quality(research|needs_id|casual|curated), photo_url, raw_object_id,
                 canonical_id NULL, UNIQUE(source_id, ext_id)
sighting_revisions sighting_id, changed_at, field, old, new
stations         id, source_id, ext_id, name, lat, lon, kind(buoy|gage|tide|grid|goes_cell)
readings         station_id, param(lst_c|air_c|water_c|sst_c|rain_mm|stage_m|wave_m|wind_ms|fire_frp),
                 value NULL, flag(ok|cloud|bad_dqf|missing), observed_at,
                 origin(measured|satellite|modeled), raw_object_id
                 PK(station_id, param, observed_at, origin)
alerts           id, ext_id, event, severity, area_geojson, onset, expires, headline, raw_object_id
frames           frame_at, payload BLOB         -- columnar: sightings, readings, hotspot grids
```

### `team.db`

```
ops              seq PK, id UNIQUE, board_id, hlc, entity, entity_id, field, value, node_id, received_at
missions, notes, messages, removal_counts     -- materialized from ops
```

### Data quality

| Case | Detection | Treatment |
|---|---|---|
| Stale feed | now − newest `observed_at` > `max_latency_s` | Feed chip (nominal/lagging/stale/down), after God's Eye View `feedState.js`. The envelope rides on every agent tool result, and the agent must say it. |
| Missing | Cloud or DQF flag; error or empty `fetch_run`; station silent | Hatched on the timeline and the globe. Never interpolated. |
| Duplicate | GBIF `catalogNumber` is an iNat id; NAS within 50 m / 24 h, same taxon | `canonical_id` link. One pin with an "also reported by" list. |
| Conflicting | iNat ID flip; satellite vs buoy SST > 1.5 °C; LST vs air temp outside the expected skin offset | A revision row and a conflict badge. The agent prefers in-situ readings and research-grade sightings, and names the disagreement. |
| Late | NAS/GBIF lag; GOES product latency | Placed at `observed_at`. The drawer shows ingest lag. |

## 8. Hotspot score (explainable heuristic, Rust + rayon)

For each 0.01° cell and frame *t*:

```
score = density(t) × activity(species, conditions(t)) × access(species, conditions(t))
```

- **density:** kernel-weighted recent sightings, with a half-life per species (python 21 d, iguana 14 d, tegu 14 d, lionfish 60 d). NAS/GBIF history counts at 0.2 weight as a prior.
- **activity:** a rule table per species in `rules.rs`, each rule citing its rationale.
  - Python: warm-night LST/air temp window.
  - Iguana: cold stun below 10 °C air temp, which marks an easy-capture window.
  - Tegu: seasonal drop Oct–Feb.
  - Lionfish: year-round.
- **access:** whether crews can work there.
  - Lionfish: wave < 1.2 m and wind < 8 m/s.
  - Python: levee access helped by lower stage.
- **Explain:** `explainCell` returns each term's contribution, for the UI and the agent.
- **Backtest:** for each day D, score using data before D. Report the share of D's sightings that fell in the top 10 % of cells, against the 10 % baseline. The result is shown as measured, even if weak.

## 9. GraphQL surface (Axum, `/v1/graphql`)

```graphql
type Query {
  feeds: [FeedState!]!
  sightings(bbox: BBox!, from: Time!, to: Time!, taxa: [ID!], quality: [Quality!]): [Sighting!]!
  readings(bbox: BBox!, from: Time!, to: Time!, params: [Param!]): [Reading!]!
  alerts(bbox: BBox!, at: Time!): [Alert!]!
  frames(from: Time!, to: Time!, stepMinutes: Int!): FrameChunk!        # columnar
  hotspots(species: ID!, at: Time!, bbox: BBox!, top: Int): HotspotGrid!
  explainCell(cell: ID!, species: ID!, at: Time!): HotspotExplain!
  backtest(species: ID!, days: Int!): Backtest!
  evidence(id: ID!): Evidence!
  board(id: ID!): Board!
  opsSince(boardId: ID!, seq: Int!): [Op!]!
}
type Mutation { applyOps(boardId: ID!, ops: [OpInput!]!): ApplyResult! }
type Subscription {
  feeds: FeedState!
  framesUpdated: FrameRange!
  ops(boardId: ID!, afterSeq: Int!): Op!
}
```

Subscriptions run over graphql-transport-ws (big-value pattern). In dev the gql worker connects to Axum directly, because Next rewrites don't proxy WebSocket upgrades. In production Caddy routes `/v1/*` to Axum.

## 10. Agent (cordis + DeepSeek)

The harness is ported from deedee `server/agent-platform/cordis/*` and `runtime/*`. It is stripped of Jev, memory, skills and Supabase.

- **Boot:** `bootHarness(mode)` caches a live context and a mock context. `cordis.yml` sets the default model to `deepseek-v4-flash` on Fireworks, with `deepseek-v4-pro` for escalation. The tool-result pruner is on.
- **Turn runner:** `runTurn({sessionId, question, view})` opens the agent handle, binds the capability tools, injects prior history and the current view (camera, time, layers, selection), then follows up with the question and waits.
- **Capability tools:** a zod registry converted to dsh `ToolDefinition`s. Each tool is one GraphQL call.

  | Tool | Purpose |
  |---|---|
  | `geocode` | Local gazetteer of Everglades units, Keys and marinas, then Open-Meteo |
  | `sightings` | Sightings by area, time, taxa and quality |
  | `conditions` | Readings (temperature, water, sea state) for an area and time |
  | `alerts` | NWS alerts in effect |
  | `hotspots` | Top-scoring cells for a species |
  | `explain_cell` | Term-by-term breakdown of one cell's score |
  | `backtest` | Hit rate of past hotspot scores |
  | `feed_state` | Freshness of every feed |
  | `set_view` | Emits a view event; the client flies the globe and timeline |

  Every result row carries `{kind, id}` for highlighting, plus the feed-state envelope (God's Eye View analyst pattern).
- **Grounding:**
  - Claims cite `[e:<id>]`.
  - The stream bridge tracks the ids that tools returned in this turn. It strips any citation outside that set and emits a `debug` event marking the answer as having an unverified claim removed.
  - The system prompt requires stating staleness, conflicts, and that hotspots are heuristic.
- **Streaming:** `POST /api/agent/stream` returns NDJSON using deedee's event union (`status | reasoning_delta | content_delta | tool_start | tool_end | context | done | error`), plus `view` and `citation` events.
- **Limits:** deedee `limits.ts` pattern.
  - Per turn: 12 turns, 30 tool calls, 90 s.
  - Global: a daily token budget through the token-meter plugin.
  - Answer cache keyed by (normalized question, data version).
- **Tests and eval:**
  - Harness tests use the mock LLM, as in deedee `tests/server/agent-platform/cordis/*`.
  - `bun run eval` runs about 15 golden questions against a frozen fixture DB and checks the tools called and the citation validity.

## 11. Voice (grok-voice)

The voice path is ported from deedee `client/voice/*`, `server/voice/*` and `shared/voice/protocol.ts`.

- **Model:** xAI `grok-voice-latest` over `wss://api.x.ai/v1/realtime`, with a server relay. The API key never reaches the browser.
- **Transport:** deedee's contract, unchanged.
  - `POST /api/voice/session` returns `{sessionId, token}`.
  - `POST …/audio` carries base64 PCM16 batches at 16 kHz, 200 ms each.
  - `GET …/events` returns an NDJSON stream.
  - `POST …/control` carries interrupt, text, playback receipts and close.
- **Audio:**
  - Capture: AudioWorklet mic capture with AEC, NS and AGC.
  - Playback: 24 kHz PCM16 via scheduled `AudioBufferSourceNode`s.
  - VAD: server-side.
  - Barge-in: both provider-side and client-side (RMS detector).
- **Tools for Grok:**
  - **Direct UI tools, new:** `fly_to`, `set_time`, `play_timeline`, `toggle_layer`, `select`, `open_evidence`. They return instantly, and the client applies them through active-state keys. This covers God's Eye View-style command-and-control.
  - **Handoff tools, from deedee:** `spawn_thinking`, `get_task_status`, `cancel_task`. `spawn_thinking` runs the same cordis `runTurn`. The answer streams into the orb card, and Grok speaks a summary in the announcement window.
  - **`view_screen`:** returns the HUD state as JSON (camera, time, visible layers, selection, top hotspots). No image goes to the model.
- **Caps:** 5 min per session and a daily minute budget, from deedee `protocol.ts` caps.
- **COEP:** the AudioWorklet loads from a Blob URL, which is same-origin and fine under `require-corp`.

## 12. Client

### Layout (app-first)

- **Base:** a full-bleed Cesium globe with the HUD on top. There is no side menu.
- **Top bar:** feed-state chips, UTC and local clock, cursor coordinates, theme mode.
- **Bottom:** the timeline scrubber, with gap hatching, alert bands and a sighting-density sparkline.
- **Left edge:** a collapsible Missions panel with mission cards, removal totals, team chat and peer presence.
- **Right edge:** the evidence drawer, which opens when needed.
- **Agent orb (bottom right):**
  - At idle it is a small presence dot.
  - While listening or speaking it shows a pulse ring (deedee `voice-mode.styled.ts`).
  - On click it morphs into a chat card of about 360×480 using deedee's `RectMorphPortal` / `useRectMorph`, and collapses back on Esc or click-away.
  - The card reuses deedee `client/ui/chat/*` primitives: the NDJSON reader, incremental markdown output, and the `ActionTimeline` tool rows.
- **Mobile (375 px):** panels become bottom sheets, and the orb stays in its corner.

### Globe (CesiumJS + ion Community)

- **Assets:** served from `public/cesium` with `CESIUM_BASE_URL`. The viewer is client-only and its widgets are hidden.
- **Imagery ladder** (God's Eye View `src/maps/imagery.js`):
  - Google Photorealistic 3D over Miami and the Keys, with Bing aerial elsewhere, both through ion.
  - Cesium World Terrain.
  - A keyless Esri/OSM fallback, switched automatically near the Community quota (1,000 root tiles and 1,000 imagery sessions a month).
- **Layer contract:** each layer implements `init / enable / disable / update(frame) / stats`.
  - Layers: sightings (`PointPrimitiveCollection` plus a billboard for each focus species), hotspot heatmap (a canvas texture from the SAB grid on a ground rectangle), LST/SST raster, stations, alerts, missions, and peer cursors.
  - Primitives only, not Entities.
- **Render governor:** `requestRenderMode` when idle.
- **Clock:** the Cesium clock follows the `TIME` key.
- **HUD overlays:** detection brackets and labels with collision arbitration on cited or selected entities (God's Eye View `detection.js`, `labelArbiter.js`), and a scope-mask focus mode for missions.
- **Share links:** state lives in the URL hash (God's Eye View `sharelink.js`).

### Theme and state

- **Theme:** `active-theme` with `light`, `dark` and `tactical` modes. Palettes are ported from big-value `client/themes/tokens.ts`, and a pre-paint `data-theme` bootstrap avoids flash.
- **State:** `@calvinjs/active-state` keys: `TIME`, `VIEW`, `LAYERS`, `SELECTION`, `FEEDS`, `MISSIONS`, `PEERS`, `ME`, `AGENT_CARD` (the chat column: tab, phone sheet height, unread dots; the orb it was named for was replaced by the column in T40), `AGENT_CHAT`, `VOICE`. The key pattern follows deedee `SHELL_CHAT.ts`.

### New tech 1: threaded active-state (`packages/active-state`, `./threads`)

The fork lives as a git subtree on branch `threads`, to be pushed upstream as v0.2. The API is unchanged: `key / get / set / subscribe / useActiveState` work from any thread.

**Threads:**

| Thread | Owns |
|---|---|
| main | React, Cesium, `RTCPeerConnection` shell, AudioWorklet host, playback |
| gql worker | GraphQL HTTP, graphql-transport-ws subscriptions |
| db worker | sqlite-wasm, CRDT, frame cache |
| rtc worker | Transferred `RTCDataChannel`s |

Transferring data channels works in Chrome/Edge 130+ and Safari 15+. On Firefox, main relays the bytes through the ring.

**Transport:**
- There is one `SharedArrayBuffer` per thread pair.
- It holds an `Int32Array` control block (cursors, plus a version per key index) and an SPSC byte ring of `(keyIndex, len, bytes)` frames.
- Writers `Atomics.notify`. Readers use `Atomics.waitAsync` on main and `Atomics.wait` in workers.

**Bulk data:** frames and hotspot grids arrive from Axum as columnar binary. The db worker caches them in SQLite and writes them into `Float32Array` views over a SAB. Cesium layers read these with no copy, so scrubbing never touches the network.

**Isolation:**
- Headers: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Safari lacks `credentialless`.
- iNat photos and other third-party media go through Axum `/v1/media/:id`, which is same-origin and cached in R2.
- Fonts are self-hosted, and there are no iframes.

**Fallback:** a `postMessage` transport with the same API, used when `crossOriginIsolated` is false.

### New tech 2: local SQLite + CRDT + optimistic rendering

- **Engine:** `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS in the db worker. A Web Locks leader tab owns it, and other tabs proxy over `BroadcastChannel`.
- **Tables:** `cache_frames`, `cache_queries` (TTL by feed cadence), `ops`, the materialized `missions` / `notes` / `messages` / `removal_counts`, and `outbox`.
- **Reads:** stale-while-revalidate.
- **CRDT:**
  - An HLC `(wallMs, counter, nodeId)` on every op.
  - Last-writer-wins per field for missions and notes, with tombstone deletes.
  - Messages are append-only, ordered by HLC.
  - Removal counts are a grow-only counter per node.
  - `apply` is idempotent on op id.
  - The Rust and TS implementations are held to `spec/crdt/*.json`.
- **Write path:**
  1. Local apply, rendered in the same frame.
  2. The rtc worker broadcasts to peers (< 150 ms).
  3. The gql worker sends `applyOps`. Axum assigns `seq`, persists, and publishes to the Hub, which reaches `ops` subscribers.
  4. The outbox entry is marked acked.
  - On reconnect, the client pulls `opsSince(lastSeq)`.

### New tech 3: WebRTC signaling on Cloudflare Workers + R2

- **Rooms:** one room per board, as a mesh of up to 8 peers.
- **Endpoints:**
  - `POST/GET /rooms/:room/peers`: announce and list, with a 60 s heartbeat.
  - `POST/GET /rooms/:room/inbox/:peer`: offer, answer and ICE; polled, then deleted after reading.
  - `GET /turn`: short-lived Cloudflare Realtime TURN credentials.
- **Storage:** R2 has strong read-after-write consistency. Peer-list writes use `onlyIf` etag, and a lifecycle rule deletes objects after 1 day.
- **Polling:** 500 ms, only during the handshake. After that, everything rides the DataChannel.
- **Upgrade path:** Durable Objects with WebSocket hibernation.

## 13. Performance targets

| Interaction | Target |
|---|---|
| Scrub frame change | < 16 ms (SAB, no network) |
| Cached query (client SQLite) | < 20 ms |
| Voice UI command (fly_to etc.) to globe moving | < 800 ms from end of speech |
| First agent token | < 2 s p50 |
| Optimistic edit, local | same frame |
| Edit to RTC peer | < 150 ms p50 |
| Edit via WS fallback | < 1 s p50 |
| GOES push to frame visible | < 60 s after SQS delivery |
| Poll freshness | ≤ cadence + 2 min |
| Globe idle CPU | ~0 |

## 14. Deployment and cost

- **Hetzner CX22-class VM** (Ubuntu 24.04, about €5/mo), with Caddy for `inversa.calvinmaighan.dev`:
  - `/v1/*` and `/health` go to Axum (`127.0.0.1:4041`), including WebSocket upgrades.
  - Everything else goes to Next (`127.0.0.1:3050`).
  - COOP/COEP are set on every response.
- **systemd** (big-value units): `inversa-api`, `inversa-web`, `inversa-litestream`.
- **Restore:** `litestream restore` on boot if the databases are missing. The restore drill is a milestone gate.
- **CI:**
  - `check.yml`: lint, typecheck, `bun test`, `cargo clippy` and `cargo test`.
  - `release.yml`: native `cargo build --release` on ubuntu-24.04, plus `next build`.
  - `deploy.yml`: scp to the VM, render `/etc/inversa/env` from Doppler, restart the units.
  - `workers.yml`: `wrangler deploy`.
- **AWS:** one SQS queue subscribed to `arn:aws:sns:us-east-1:123901341784:NewGOES19Object`, with a key-prefix filter policy, and an IAM user with `sqs:ReceiveMessage` / `DeleteMessage` only.
- **Secrets:** `FIREWORKS_API_KEY`, `XAI_API_KEY`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `GOES_SQS_URL`, `NWWS_USER` / `NWWS_PASS` (later), the R2 key pair, `CESIUM_ION_TOKEN`, the Cloudflare TURN key, `INGEST_HOOK_SECRET`.
- **Monthly cost:** VM about €5, Cloudflare $0, AWS about $0 (free tier), ion $0 (personal demo), plus metered DeepSeek and grok-voice under the daily caps.

## 15. Plan: 10 working days, one senior developer

| Day | Deliverable | Done when |
|---|---|---|
| 1 | Scaffold + deploy skeleton | Monorepo; `api/` from big-value skeleton; Next shell; subtrees; theme modes; CI green; Caddy + both units + Litestream live at the domain with `crossOriginIsolated === true`; NWWS-OI requested; SQS queue subscribed |
| 2 | Axum data core | Writer thread + read pool; migrations; R2 archive; scheduler + rate governor; iNat, NWS, Open-Meteo pollers with fixture tests; feed state; GraphQL reads |
| 3 | Push + remaining feeds | GOES SQS consumer + NetCDF bbox window (LST, SST, FDC, clear-sky); USGS, NDBC, CO-OPS, NAS, GBIF; dedupe, revisions, conflicts; 30-day backfill |
| 4 | Globe + HUD | Cesium viewer, imagery ladder, layer contract, sightings/stations/alerts/raster layers, render governor, feed chips, detection brackets |
| 5 | Timeline + hotspots + evidence | rayon frame builder, columnar frames, scrubber, hotspot heatmap + explain + backtest, evidence drawer down to the raw payload, share links |
| 6 | Agent | cordis harness port, capability tools over GraphQL, NDJSON stream, citation checker, limits, eval passing; orb + morph card + chat |
| 7 | Voice | grok relay + deedee audio pipeline; direct UI tools; `spawn_thinking` handoff; announcement window; caps |
| 8 | Threaded client | active-state `./threads` (SAB ring + fallback) with tests; gql + db workers; sqlite-wasm cache; SAB frames feeding Cesium |
| 9 | Team realtime | CRDT in Rust + TS against shared vectors; Missions panel; optimistic ops; WS fan-out; `opsSince`; signal Worker + TURN; rtc worker; team chat |
| 10 | Ship | HUD polish, perf pass against targets, restore drill, README, demo script, interview notes |

If time runs short, cut in this order:

1. Firecrawl hook source.
2. NWWS-OI (the poll stays).
3. The Firefox rtc relay.
4. Multi-tab leader election.
5. The rtc worker (DataChannels stay on main).
6. Google 3D tiles.
7. Client-side barge-in (provider VAD only).

Days 1–7 and 10 cover the brief and are non-negotiable.

## 16. Risks

| Risk | Mitigation |
|---|---|
| NetCDF/HDF5 build pain in Rust | Day-1 spike with the `netcdf` crate's `static` feature on ubuntu-24.04. GOES NetCDF4 files are HDF5, so the fallback is the `hdf5` crate against apt `libhdf5-dev`. |
| SNS filter misses or floods | Payload filter tested with a sample event; SQS depth alarm in feed state |
| NWWS-OI approval slower than 10 days | NWS API poll is the permanent fallback |
| Sparse live sightings on demo day | 30-day window, 5-year baseline, and a recorded cold-snap replay fixture (date picked from backfill) |
| ion quota exhausted by reviewers | Quota counter plus automatic keyless imagery |
| COEP blocks a resource | require-corp, same-origin media proxy, self-hosted fonts, postMessage fallback |
| `@deepseek-ai/*` harness packages are rc-pinned | Pin exact versions from deedee; mock-LLM tests guard upgrades |
| Voice cost and latency | Direct UI tools skip the LLM hop; 5 min session cap; daily minute budget |
| OPFS single connection | Web Locks leader, or a single-tab notice |
| Scope | Cut order above; every new-tech layer sits behind an interface with a plain fallback |

## 17. Scaling story (for the interview)

- **More regions or species:** each is config (bbox, taxa, rules) plus adapters. Lionfish across the Caribbean (Belize, Colombia, Mexico) and carp in the Mississippi basin fit the same pipeline.
- **More data:**
  - Monthly partitions as attached SQLite files, or analytics in ClickHouse.
  - Frames become immutable R2 chunks behind a CDN.
  - GOES processing scales out across rayon cores first, then to more workers reading SQS.
- **More traffic:** Axum is stateless apart from the writer, so replicas can serve reads from Litestream followers while one writer ingests. Voice sessions need sticky routing or a shared session store.
- **More users per board:** an SFU (Cloudflare Realtime) instead of the mesh, and Durable Objects for signaling.
- **Field integration, the Origin analogue:** Inversa's body-cam and drone detections become another sightings source with `quality=ai_confirmed`, feeding the same evidence and hotspot pipeline.
