# Smoke Trail: PRD

Inversa take-home. Status: draft v1, 2026-09-30.

## 1. Problem

The brief asks for a natural-language interface over three or more real-time physical-world feeds, with evidence tracing and a replayable timeline, deployed at a shared URL. At least one meaningful part must use technology new to the author.

### The question

**"Where is the wildfire smoke I'm breathing coming from, and is it getting better or worse?"**

It matters because smoke is the most common way wildfire reaches people who are nowhere near a fire. Canadian fire seasons now push smoke into Montreal, Toronto, New York and Chicago every summer. Answering it needs several feeds, because no single one covers it:

- Fires say where smoke starts, but not where it goes.
- Wind says where it goes, but not how much there is.
- Air-quality stations say what people breathe, but not why.
- Official alerts say what authorities have concluded, and they lag the sensors.

Joining them gives a causal chain the user can follow: *this PM2.5 spike at this station, downwind of these fire detections, under this wind field, with this official alert in effect*. Each hop is evidence the user can open.

Fallback question if smoke season is quiet at demo time: river flooding (USGS streamflow + NWS alerts + Open-Meteo precipitation + NOAA tides). The ingest, storage and client layers are source-agnostic, so a swap costs adapters and prompts only.

### Scope

North America (US + Canada), rolling 30 days hot, 7-day backfill on first boot.

## 2. Data feeds

| Feed | What it gives | Cadence / latency | Key | Role |
|---|---|---|---|---|
| NASA FIRMS (VIIRS SNPP, NOAA-20, NOAA-21, MODIS NRT) | Active fire detections, FRP | ~3 h latency | `FIRMS_MAP_KEY` (free) | Smoke sources |
| OpenAQ v3 | Measured PM2.5 / PM10 / O3 at stations | Hourly, uneven per station | `OPENAQ_API_KEY` (free) | Ground truth |
| Open-Meteo forecast + air-quality | Hourly 10 m wind, modeled PM2.5 (CAMS) | Hourly | none | Transport + model baseline |
| NWS alerts (api.weather.gov) | Air Quality Alerts, Red Flag Warnings (US) | Minutes | none (User-Agent required) | Official conclusions |
| ECCC MSC GeoMet (stretch) | AQHI observations, special air quality statements (Canada) | Hourly | none | Canadian official view |

Modeled PM2.5 (Open-Meteo/CAMS) against measured PM2.5 (OpenAQ) is deliberate: it gives a real, explainable source of conflicting data.

## 3. Users and core flows

No auth, accounts or permissions (the brief rules these out). A viewer picks a display name and colour, stored locally.

1. **Ask.** Type a question ("Why is Montreal's air bad today?"). The answer streams in with inline citations. The map flies to the relevant region.
2. **Follow evidence.** Click a citation to open the evidence drawer: the normalized record, then the raw payload as fetched, the source URL, fetch time and freshness status.
3. **Replay.** Scrub the timeline (15-minute frames, up to 30 days). Fires, wind arrows and AQ stations animate. Gaps render as gaps and are never interpolated.
4. **Share to the team dashboard.** Pin an answer, an evidence card or a map view to a shared dashboard. Annotate it and chat. Edits show instantly for the author, reach connected peers over WebRTC in under ~150 ms, and persist through the server.

## 4. Non-goals

- Auth, identity or permissions.
- Test-coverage targets. Tests exist where logic is subtle: CRDT merge, feed normalization, ring buffer.
- Forecasting smoke dispersion. We show wind and upstream fires. We do not run a dispersion model.
- Mobile-native apps. The web UI stays usable at phone width.

## 5. Architecture

```
                        ┌──────────────────── Cloudflare ────────────────────┐
                        │  Worker: signal  ──  R2: signal mailbox (TTL 1 d)   │
                        │  R2: raw payloads, litestream replica, pmtiles      │
                        └──────────▲──────────────────────────▲──────────────┘
                                   │ SDP / ICE                │ S3 API
 Browser                           │                          │
 ┌─────────────────────────────────┼────────┐   ┌─────────────┴──── Hetzner VM ─────────────┐
 │ main: React, MapLibre,          │        │   │ Caddy (TLS, COOP/COEP headers)             │
 │       RTCPeerConnection shell ──┘        │   │  └─ web: Next.js 16 on Bun                 │
 │   ▲ SharedArrayBuffer rings + Atomics    │   │       /api/graphql  (graphql-yoga, SSE)    │
 │   ▼                                      │   │       agent (Claude, tool use)             │
 │ gql worker ── fetch/SSE ─────────────────┼──►│  ingest: Bun daemon, one loop per feed     │
 │ rtc worker ── transferred RTCDataChannel │   │  bun:sqlite (WAL) ── litestream ──► R2     │
 │ db worker  ── sqlite-wasm (OPFS) + CRDT  │   └────────────────────────────────────────────┘
 └──────────────────────────────────────────┘
        ▲ RTCDataChannel (P2P, TURN fallback) ▼  other team members
```

### Boundaries

- **ingest** owns writes to observation tables. **web** only reads them.
- **web** owns team-dashboard writes (the ops table) and the agent.
- **signal** knows nothing about app data. It only relays SDP and ICE.
- **client db worker** owns the local database. Other threads never touch SQLite.
- **packages/feeds** holds pure adapters (payload in, normalized rows out), tested against recorded fixtures.
- **packages/crdt** holds merge logic, shared verbatim by server and client.

### Repo layout (bun workspaces)

Conventions come from big-value: strict TS, `client/state` catalog, `Providers.tsx`, bun test with a mirrored `tests/` tree, a `deploy/` folder, and a custom ESLint plugin.

```
apps/web/              Next.js 16 App Router, output: standalone
  app/                 routes, /api/graphql, layout (theme bootstrap)
  client/state/        active-state keys + catalog
  client/threads/      gql, rtc, db worker entries
  client/ui/           components, Providers.tsx
  client/themes/       active-theme definition + Emotion tokens
  server/graphql/      yoga, SDL, resolvers
  server/agent/        Claude loop, tools, citation checker
apps/ingest/           Bun daemon: schedulers, backfill, health
apps/signal/           Cloudflare Worker (wrangler)
packages/active-state/ fork of CalvinMaighan/active-state (git subtree) + ./threads
packages/active-theme/ subtree, with the @calvinjs/active-state import fix
packages/feeds/        FIRMS, OpenAQ, Open-Meteo, NWS, ECCC adapters
packages/db/           migrations, typed queries over bun:sqlite
packages/crdt/         HLC, LWW-field ops, apply/merge
packages/schema/       GraphQL SDL + codegen types (server + client)
deploy/                Caddyfile, systemd units, litestream.yml, bootstrap.sh
docs/                  PRD, ADRs, demo script
```

## 6. Server

### Stack

- Bun runtime, Next.js 16 (App Router, `output: standalone`), React 19.2, TypeScript strict.
- GraphQL: `graphql-yoga` 5 mounted in a Next route handler, following deedee's `server/graphql/yoga.ts`. The schema is SDL-first, with `graphql-codegen` for resolver and operation types. Subscriptions run over SSE (yoga native), so there is no WebSocket server.
- SQLite via `bun:sqlite` in WAL mode, with Litestream replicating to R2. There are two databases: `observations.db` (written by ingest) and `team.db` (written by web), so neither process contends for the other's writer lock.
- Raw payloads are stored gzip-compressed in R2 at `raw/{source}/{yyyy}/{mm}/{dd}/{sha256}.json.gz`.

### Data model (`observations.db`)

```
sources        id, name, url, cadence_s, max_latency_s
fetch_runs     id, source_id, started_at, finished_at, status(ok|empty|error|partial),
               error, rows_in, raw_object_id
raw_objects    id, sha256 UNIQUE, r2_key, source_url, fetched_at, bytes
stations       id, source_id, ext_id, name, lat, lon, kind(monitor|sensor|grid_point)
fire_detections id, satellite, lat, lon, acq_at, frp, confidence, raw_object_id
               UNIQUE(satellite, lat, lon, acq_at)
aq_measurements station_id, param(pm25|pm10|o3), value, unit, observed_at,
               origin(measured|modeled), raw_object_id   PK(station_id, param, observed_at, origin)
wind_samples   station_id, observed_at, speed_ms, dir_deg, raw_object_id
alerts         id, source_id, ext_id, event, severity, area_geojson, onset, expires,
               headline, raw_object_id
timeline_frames bbox_cell, frame_at, payload BLOB   -- precomputed columnar frames
```

- Every observation row carries `observed_at` (when it happened), a `raw_object_id` (where it came from) and, through `fetch_runs`, `ingested_at`.
- Units are normalized at the adapter boundary. The original unit is kept in the raw payload.
- Spatial queries use a bbox on indexed `(lat, lon, time)` columns. At this volume (tens of thousands of rows per day) that holds. The R\*Tree module is the next step if it doesn't.

### Data quality

| Case | Detection | Treatment |
|---|---|---|
| Stale | now − newest `observed_at` > source `max_latency_s` | Source health chip turns amber/red. Tool results carry `freshness`. The agent must say so. |
| Missing | `fetch_runs.status` is error or empty, or a station has no row for an expected hour | The timeline draws a hatched gap. No interpolation. |
| Conflicting | measured vs modeled PM2.5 differ by more than max(10 µg/m³, 50 %); sensors in one cell disagree | Both values are shown with an explicit conflict badge. The agent names the conflict and prefers measured. |
| Duplicate | The same fire is seen by several satellites | Each detection is kept. Detections are clustered for display by distance and time window. |
| Late | FIRMS arrives about 3 h after the satellite pass | Rows are placed at `acq_at`, not at fetch time. A replay of "now" shows the latency. |

### Ingest

- A Bun daemon runs one async loop per source with jittered interval, exponential backoff and per-source rate limits (OpenAQ is the tight one).
- Each run follows the same steps:
  1. Fetch the payload.
  2. Hash it.
  3. Put it in R2 (skipped if the hash was seen before).
  4. Normalize via `packages/feeds`.
  5. Upsert in one transaction.
  6. Record the `fetch_run`.
  7. Rebuild the affected timeline frames.
- Backfill runs on first boot: FIRMS for 7 days (the API allows 10), plus OpenAQ and Open-Meteo history for the same window.
- Health is exposed to GraphQL as `sourceHealth`.

### GraphQL surface (sketch)

```graphql
type Query {
  sourceHealth: [SourceHealth!]!
  observations(bbox: BBox!, from: Time!, to: Time!, kinds: [Kind!]): ObservationPage!
  timeline(bbox: BBox!, from: Time!, to: Time!, stepMinutes: Int!): TimelineChunk!   # columnar, cache-friendly
  evidence(id: ID!): Evidence!            # normalized row + raw object + source url
  dashboard(id: ID!): Dashboard!
  opsSince(dashboardId: ID!, seq: Int!): [Op!]!
}
type Mutation {
  ask(question: String!, view: ViewInput): AskHandle!
  applyOps(dashboardId: ID!, ops: [OpInput!]!): ApplyResult!   # returns server seq per op
}
type Subscription {
  answer(askId: ID!): AnswerChunk!        # streamed tokens, tool calls, citations
  ops(dashboardId: ID!, afterSeq: Int!): Op!
}
```

## 7. Agent

- **Model:** Claude via the Anthropic SDK with tool use and streaming. The default is `claude-sonnet-5-5` for latency. Model choice is to be confirmed against current pricing when building.
- **Tools** call the same service layer the resolvers use, in process with no HTTP hop:
  - `geocode(place)`: Open-Meteo geocoding.
  - `fires(bbox, from, to)`
  - `air_quality(bbox|station, from, to, origin?)`
  - `wind(bbox, at)`
  - `alerts(bbox, at)`
  - `upwind_fires(point, at, hours)`: walks the hourly wind field backwards from a point and returns fire clusters within a cone. This is not a dispersion model, and the tool result says so.
  - `source_health()`
- **Grounding contract:**
  - Every tool result row has an evidence id.
  - The model must cite claims as `[e:<id>]`.
  - The server checks that each cited id was returned by a tool in this run. Unknown ids are stripped and the answer is flagged.
  - Tool results include freshness and conflict flags. The system prompt requires stating them.
- **Map sync:** the answer also emits a `view` (bbox + time) so the map and timeline jump to the evidence.
- **Eval:** about 15 golden questions with expected tool calls and citable facts, run with `bun run eval` against a frozen fixture DB.

## 8. Client

### Theme and state

- The theme uses `active-theme` with palettes ported from big-value's `client/themes/tokens.ts`. The `data-theme` bootstrap script in `layout.tsx` prevents a flash (manhwa-ai pattern).
- State uses `@calvinjs/active-state` keys in `client/state/`, mounted once via `<ActiveState init={state} ssr />` in `Providers.tsx`.
- `active-theme`'s `/state` adapter imports the unscoped `active-state`. It gets fixed in the subtree.

### New technology 1: threaded active-state (`@calvinjs/active-state/threads`)

GitHub does not allow forking a repo into the account that owns it. The fork lives as a git subtree at `packages/active-state`, branch `threads`, so it can be pushed back upstream as v0.2.

**Goal:** the same `key` / `get` / `set` / `subscribe` / `useActiveState` API, callable from any thread, with the main thread doing nothing but rendering.

- **Threads:**
  - **main:** React, MapLibre, and the `RTCPeerConnection` shell. Workers cannot construct peer connections.
  - **gql worker:** GraphQL fetches and the SSE subscriptions.
  - **rtc worker:** owns the transferred `RTCDataChannel`s. Transfer is supported in Chrome/Edge 130+ and Safari 15+. On Firefox, main relays bytes through the ring instead.
  - **db worker:** sqlite-wasm, the CRDT, and the query cache.
- **Transport:** one `SharedArrayBuffer` per thread pair:
  - an `Int32Array` control block (write and read cursors, and a version counter per key index);
  - an SPSC byte ring carrying `(keyIndex, len, bytes)` frames, with values encoded as JSON via `TextEncoder`. A spike will decide whether msgpack is worth it.
  - The writer bumps the version and calls `Atomics.notify`. Readers wait with `Atomics.waitAsync` (main thread) or `Atomics.wait` (workers), decode, and call local subscribers. React re-renders through the existing hooks.
- **Bulk data:** timeline frames are written by the db worker straight into a `Float32Array` over a SAB. MapLibre custom layers read it on the main thread with no copy or decode, which is what makes scrubbing cheap.
- **Fallback:** without cross-origin isolation, the transport becomes `postMessage` with an identical API. It is detected at boot.
- **Requirements:** `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, set in Caddy and in `next.config` headers. Every third-party subresource must be CORS/CORP-clean. Base tiles are therefore self-hosted Protomaps PMTiles in R2, served with `Cross-Origin-Resource-Policy`.

### New technology 2: local SQLite + CRDT + optimistic rendering

- **Engine:** official `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS in the db worker. It is fast, needs no COOP/COEP itself, and works in all evergreen browsers. IndexedDB (wa-sqlite `IDBBatchAtomicVFS`) is a fallback only if OPFS is unavailable, and isn't built unless testing shows the need.
- **Multi-tab:** `opfs-sahpool` is single-connection. A Web Locks leader tab owns the db worker. Other tabs proxy queries over `BroadcastChannel`.
- **Local tables:**
  - `cache_frames` (timeline chunks keyed by bbox cell + frame range, with ETag)
  - `cache_queries` (query hash → rows, TTL by source cadence)
  - `ops`
  - materialized `cards`, `annotations`, `messages`
  - `outbox`
- **Read path:** a component reads through an active-state key, and the db worker answers from cache immediately (stale-while-revalidate). The gql worker revalidates and the db worker upserts, which bumps the key.
- **CRDT (`packages/crdt`):**
  - Hybrid logical clock `(wallMs, counter, nodeId)`.
  - Each op is `{id, hlc, entity, entityId, field, value}`.
  - Cards and annotations are last-writer-wins per field. Deletes are a tombstone field.
  - Messages are append-only, ordered by HLC.
  - Apply is idempotent on `id`, so ops can arrive from RTC, SSE and `opsSince` in any order and converge.
  - The same `apply(db, op)` runs on server (`bun:sqlite`) and client (sqlite-wasm) behind a two-method `Db` interface.
- **Write path (optimistic patch):**
  1. The user edits.
  2. The db worker applies the op locally, bumps the keys, and the UI renders.
  3. The rtc worker broadcasts the op to peers over the DataChannel. Peers apply and render in under ~150 ms.
  4. The gql worker sends `applyOps` to the server, which assigns a `seq`, persists and fans out over SSE.
  5. The client marks the op acked in `outbox`.
- **Recovery:** on reconnect the client pulls `opsSince(lastSeq)`. The server is the durable source of truth, and RTC is only the fast path. A peer with no RTC link still converges via SSE.

### New technology 3: WebRTC signaling on Cloudflare Workers + R2

- **Rooms:** one room per dashboard. Mesh topology, capped at 8 peers. An SFU is the evolution path.
- **Worker endpoints:**
  - `POST /rooms/:room/peers` announces a peer with `{peerId, name}`, stored with a 60 s heartbeat.
  - `GET /rooms/:room/peers` lists live peers.
  - `POST /rooms/:room/inbox/:peerId` delivers an offer, answer or ICE batch.
  - `GET /rooms/:room/inbox/:peerId` polls and deletes messages after reading them.
  - `GET /turn` mints short-lived Cloudflare Realtime TURN credentials.
- **Storage:** R2 objects under `signal/{room}/…`. R2 is strongly consistent for read-after-write, and conditional puts (`onlyIf` etag) prevent lost updates on the peer list. A lifecycle rule expires objects after 1 day.
- **Polling:** 500 ms polling runs only during handshakes, which last a few seconds. Once channels are open, all traffic, renegotiation included, goes over the DataChannel.
- **Tradeoff:** R2 has no push. Durable Objects with WebSocket hibernation would cut handshake latency and request count. R2 was chosen here per author preference and to keep the Worker stateless. Moving to Durable Objects would be a contained change behind the same client interface.

### UI

- **Layout:** the map fills most of the screen. The ask bar and answer stream sit in a left panel. The evidence drawer opens on the right. The timeline scrubber is at the bottom, with gap hatching and alert bands. Source health chips sit in the header. The team dashboard is a route with a card grid, annotation threads and chat.
- **Map:** MapLibre GL with custom layers for fires (sized by FRP), stations (coloured by AQI band, with a conflict ring), wind arrows and alert polygons.
- **Theme:** light and dark via active-theme. The layout works at 375 px width.

## 9. Performance targets

| Interaction | Target |
|---|---|
| Timeline scrub frame change | < 16 ms (served from SAB, no network) |
| First answer token | < 1.5 s p50 |
| Cached query (local SQLite) | < 20 ms |
| Optimistic edit visible locally | same frame |
| Edit visible to RTC peer | < 150 ms p50 |
| Edit visible via SSE fallback | < 1 s p50 |
| Freshness vs upstream | ≤ source cadence + 5 min |

## 10. Deployment

- **Hetzner:** one Ubuntu 24.04 VM (CPX31 class). Caddy terminates TLS and sets COOP/COEP.
- **systemd units:**
  - `inversa-web` runs the Next standalone build on Bun.
  - `inversa-ingest` runs the ingest daemon.
  - `inversa-litestream` replicates both databases to R2.
  - The unit layout is taken from big-value `deploy/`.
- **Restore:** `litestream restore` on boot if the DB is missing, so the VM is disposable.
- **Cloudflare:**
  - `apps/signal` deploys via wrangler.
  - Three R2 buckets: `inversa-raw`, `inversa-litestream`, `inversa-signal` (the last with a 1 d lifecycle).
  - PMTiles live in `inversa-raw/tiles/`.
- **CI (GitHub Actions):**
  - `check.yml` runs lint, typecheck and `bun test`.
  - `deploy.yml` builds, copies over SSH and restarts units.
  - `signal.yml` runs `wrangler deploy`.
  - Secrets come from Doppler, as in big-value.
- **Secrets:** `ANTHROPIC_API_KEY`, `FIRMS_MAP_KEY`, `OPENAQ_API_KEY`, the R2 access key pair, the Cloudflare TURN key, and the Hetzner SSH key.

## 11. Milestones and cut order

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold | Monorepo, subtrees, lint/typecheck/test green in CI, theme renders |
| M1 | Ingest + storage | 4 feeds landing, raw in R2, `sourceHealth` accurate, 7-day backfill |
| M2 | Read API + map + timeline | GraphQL queries, map layers, scrubbing over server data |
| M3 | Agent | Streaming answers with verified citations, evidence drawer to raw payload |
| M4 | Threaded client | active-state `threads`, gql/db workers, local SQLite cache, SAB timeline |
| M5 | Team dashboard | CRDT ops, optimistic edits, SSE fan-out, `opsSince` recovery |
| M6 | WebRTC | Worker + R2 signaling, TURN, rtc worker with transferred channels, chat |
| M7 | Ship | Hetzner deploy, Litestream verified by restore drill, demo script, README |

If time runs short, cut from the bottom of the new-tech stack while keeping the brief's requirements whole:

1. Firefox rtc relay.
2. The IndexedDB fallback.
3. Multi-tab leader election. Pin to a single tab with a notice.
4. The rtc worker, keeping DataChannels on main.

M1–M3 and M7 are non-negotiable.

## 12. Risks

| Risk | Mitigation |
|---|---|
| COEP breaks a third-party resource (tiles, fonts) | Self-host tiles and fonts. Use the `credentialless` COEP variant if a CDN lacks CORP. The boot check falls back to postMessage. |
| OPFS sahpool has exclusive access across tabs | Web Locks leader election (M4), or a single-tab notice |
| OpenAQ rate limits during backfill | Token bucket per key; backfill spread over the first hour |
| FIRMS 3 h latency makes "now" look fireless | Timeline shows latency explicitly; agent states it |
| R2 polling adds handshake latency | Handshake-only polling; Durable Objects noted as upgrade |
| Quiet fire season at demo time | 30-day retention + a recorded fixture of a known smoke event for the demo; flood question as fallback |
| Scope | Cut order above; new-tech layers sit behind interfaces with simple fallbacks |

## 13. Scaling story (for the interview)

- **More data:**
  - Partition observations by month into attached SQLite files, or move to ClickHouse/TimescaleDB for analytics.
  - Keep SQLite for team state.
  - Precomputed frames move to R2 as immutable chunks behind a CDN.
- **More traffic:**
  - Stateless web behind a load balancer, with read replicas via Litestream-restored followers.
  - Ingest stays a singleton with leader lease.
- **More users per room:** replace the mesh with an SFU (Cloudflare Realtime), and signaling with Durable Objects.
- **More use cases:** new feeds are an adapter plus a tool definition. Evidence and freshness handling are generic.

## 14. Open questions

1. Confirm the question: wildfire smoke, or the flood fallback?
2. Deadline and demo date. This sets how far down the cut order we plan.
3. Domain for the deployed URL.
4. Fork mechanics: git subtree in this repo (proposed), or a separate `active-state-threads` repo?
5. LLM provider and budget: Claude assumed.
