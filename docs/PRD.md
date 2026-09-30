# Everglades Ops: PRD

Inversa take-home. Status: v2, 2026-09-30. It supersedes v1 (wildfire smoke). Research and decisions are in [research.md](research.md).

- **Deploy target:** https://inversa.calvinmaighan.dev
- **Deadline:** 72 h. Sized as roughly 2 weeks (10 working days) for one senior developer. Agent tooling runs the work in parallel.

## 1. Problem

The brief asks for four things:
- a natural-language interface over three or more real-time physical-world feeds;
- evidence traceable to source;
- a replayable timeline;
- a public URL.

At least one meaningful part must use technology new to the author.

### The question

**"Where are invasive species active across South Florida right now, and where should removal crews go next?"**

Why this question, for Inversa specifically:

- Inversa runs FWC's python contractor program (PATRIC) in the Everglades: removals went from 235 in July 2024 to 748 in July 2025. It also runs lionfish programs in Florida and the Caribbean, and sells iguana and python leather.
- Its product, Origin, is an AI command center built around the loop *hotspot → mission → mission in progress → ROI*, with predictive heatmaps, geospatial alerts and real-time habitat data.
- South Florida puts four priority invaders on one map, across land and sea:
  - Burmese python
  - Argentine tegu
  - Green iguana
  - Lionfish (Biscayne Bay and the Keys)

The answer needs several feeds, because no single one covers it:
- **Sightings** say where animals were, but they're noisy, biased toward roads, and lag.
- **Conditions** (air and sea temperature, rain, water stage, waves) say where animals are likely active and whether crews can work.
- **Official alerts** (freeze, heat, marine) change both of those overnight. A cold snap stuns iguanas and kills pythons.

### Region and species

- **Bbox:** 24.3°N–27.5°N, 83.2°W–79.8°W (South Florida, Everglades, Biscayne, the Keys).
- **Focus taxa:**
  - *Python bivittatus*
  - *Salvator merianae*
  - *Iguana iguana*
  - *Pterois volitans/miles*
- **Background layer:** all iNaturalist observations flagged `introduced=true` in the bbox.

## 2. Data feeds

Nothing here pushes data, so ingestion is **webhook-driven via our own emitter** (section 6).

| Feed | Gives | Cadence | Key | Role |
|---|---|---|---|---|
| iNaturalist API v1 | Observations, photos, quality grade, community ID | Poll 5 min (`updated_since`) | none (~1 req/s etiquette) | Live sightings |
| USGS NAS API v2 | Curated nonindigenous aquatic and herp records | Daily | none | Authoritative history |
| GBIF occurrence API | Deep history. Includes iNat research grade under another id | Daily | none | History + duplicate/conflict case |
| Open-Meteo forecast + archive + marine | Air temp, rain, wind, SST, wave height | Hourly | none | Activity and field conditions |
| NOAA NDBC + CO-OPS Tides & Currents | Buoy water temp, wind; water level every 6 min | 10–60 min | none | Marine truth vs model |
| USGS Water Data (Everglades gages) | Stage / gage height, water temp | 15 min | none | Habitat state |
| NWS alerts (api.weather.gov) | Freeze, cold, heat, marine, flood | 5 min | none (User-Agent) | Official conditions |

Built-in data-quality cases:
- **Duplicates across sources:** the same animal can appear in iNat, then GBIF, then NAS, weeks apart.
- **Identifications change:** an iNat ID can flip after ingest.
- **Model vs buoy:** modelled SST can disagree with the buoy reading.
- **Gaps:** buoys and gages go offline.

## 3. Users and flows

There is no auth (per the brief). Each viewer picks a callsign and a colour, stored locally.

1. **Ask.** "Where should python crews go tonight?", "Did last week's cold snap change iguana reports?", "Is it diveable at Biscayne this weekend?" The answer streams in with inline citations. The globe flies to the evidence, and cited entities get detection brackets.
2. **Follow evidence.** A citation opens the evidence drawer: the normalized record, then the raw payload as fetched (from R2), the source URL, fetch time, feed state, and any duplicate or conflict links.
3. **Replay.** Scrub up to 30 days in 15-minute frames. Sightings, the hotspot heatmap, condition overlays and alert bands animate. Gaps render hatched and are never interpolated.
4. **Hotspot → mission.**
   - A heatmap cell becomes a mission card: species, window, conditions, evidence.
   - The card is pinned to the shared team board.
   - Crew members update its status (planned → in progress → done) and log removals.
   - The board shows totals, the way Origin does its ROI view.
5. **Team chat.** Real-time messages and edits on the board. Every change is optimistic and reaches peers over WebRTC.

## 4. Non-goals

- Auth, accounts, permissions.
- A validated ecological model. The hotspot score is an explainable heuristic, labelled as one, with a backtest panel.
- Voice control. It's a stretch goal via the Web Speech API.
- Post-process shaders (FLIR/NVG/CRT).
- Coverage targets. Tests go where logic is subtle: feed normalization, dedupe, CRDT merge, ring buffer, hotspot score.

## 5. Architecture

```
 Cloudflare ─────────────────────────────────────────────────────────────────────
  Worker "ingest"  (1 cron, every minute; dispatches due sources)
     fetch feed ─► R2 raw/{source}/{date}/{id}.json.gz ─► POST signed webhook ───┐
  Worker "signal"  (WebRTC rendezvous)  ◄──► R2 signal/{room}/… (1-day lifecycle)  │
  R2: raw payloads · litestream replica · proxied media cache                      │
 ──────────────────────────────────────────────────────────────────────────────────┼─
 Hetzner VM (Caddy TLS + COOP/COEP)                                                │
  web: Next.js 16 on Bun                                                           │
    /api/ingest/:source  ◄─────────────────────────────────────────────────────────┘
    /api/graphql  (graphql-yoga; queries, mutations, SSE subscriptions)
    /api/media/:id  (same-origin image proxy, R2-cached)
    agent (Claude tool loop, in-process tools)
    bun:sqlite WAL: observations.db, team.db ── litestream ──► R2
 ──────────────────────────────────────────────────────────────────────────────────
 Browser
  main thread: React HUD + CesiumJS globe (+ Cesium's own workers), RTCPeerConnection shell
     ▲ SharedArrayBuffer rings + Atomics (@calvinjs/active-state/threads)
     ▼
  gql worker: GraphQL fetch + SSE        db worker: sqlite-wasm (OPFS) + CRDT + frames
  rtc worker: transferred RTCDataChannels ◄──► peers (P2P, TURN fallback)
```

### Boundaries

- **ingest Worker** fetches and archives. It never parses or normalizes, which keeps it under the 10 ms free-tier CPU limit.
- **`/api/ingest`** verifies the HMAC, reads the raw object, normalizes via `packages/feeds`, and upserts `observations.db`. It is the only writer to that database.
- **GraphQL** reads `observations.db` and owns `team.db` writes.
- **signal Worker** relays SDP and ICE only. It never sees app data.
- **Client db worker** is the only thread that touches client SQLite.
- **`packages/crdt`** is shared verbatim by server and client.

### Repo layout (bun workspaces)

Conventions come from big-value: strict TS, a `client/state` catalog, `Providers.tsx`, bun test with a mirrored `tests/` tree, a `deploy/` directory, and a custom ESLint plugin. graphql-yoga wiring follows deedee's `server/graphql/yoga.ts`.

```
apps/web/               Next.js 16 App Router, output: standalone
  app/                  routes: / (ops), /board/[id], /api/{graphql,ingest,media}
  client/state/         active-state keys + catalog
  client/threads/       gql.worker.ts, db.worker.ts, rtc.worker.ts, boot.ts
  client/globe/         Cesium viewer, layers (contract below), imagery ladder, HUD overlay
  client/ui/            components, Providers.tsx
  client/themes/        active-theme definition (light, dark, tactical)
  server/graphql/       yoga, SDL, resolvers
  server/agent/         tool loop, tools, citation checker, budget guard
  server/ingest/        webhook handler, dedupe, frame builder
apps/ingest-worker/     Cloudflare Worker: cron dispatcher + R2 archive + webhook emit
apps/signal-worker/     Cloudflare Worker: signaling over R2 + TURN credential mint
packages/active-state/  git subtree of CalvinMaighan/active-state, adds ./threads
packages/active-theme/  git subtree, fixes the @calvinjs/active-state import
packages/feeds/         iNat, NAS, GBIF, Open-Meteo, NDBC, CO-OPS, USGS, NWS adapters
packages/db/            migrations + typed queries (bun:sqlite)
packages/crdt/          HLC, LWW-field ops, apply/merge
packages/hotspot/       scoring rules + backtest (pure, shared server/client)
packages/schema/        GraphQL SDL + codegen types
deploy/                 Caddyfile, systemd units, litestream.yml, bootstrap.sh
docs/                   PRD, research, ADRs, demo script
```

## 6. Ingestion (webhook-driven, low cost)

### Emitter

A Cloudflare Worker with one Cron Trigger (`* * * * *`). The free plan allows 5 triggers per account and 10 ms CPU per run. I/O wait doesn't count toward CPU.

Each tick:
1. Read the schedule (source → interval, cursor) from R2 `ingest/state.json`.
2. For each due source: fetch (with the cursor, e.g. iNat `updated_since`), stream the bytes to R2 gzip-compressed, and POST `{source, r2Key, cursor, fetchedAt, status, httpStatus}` to `/api/ingest/:source`. The request carries an `X-Signature: HMAC-SHA256(body)` header and a timestamp; a replay window of 5 minutes is enforced.
3. Advance the cursor only on a 2xx response from the webhook. Otherwise it retries on the next tick with backoff.

Rate governor (after God's Eye View's OpenSky proxy):
- per-source minimum interval;
- a 429 or 5xx response doubles the interval, up to a cap;
- the state is recorded in `ingest/state.json` and surfaced as feed state.

If CPU limits bite, the escape hatch is Workers Paid ($5/mo). The code doesn't change.

### Receiver

`/api/ingest/:source` handles each webhook:
1. Verify the HMAC.
2. Load the raw object from R2.
3. Run the `packages/feeds` adapter (pure: raw → rows).
4. Upsert in one transaction. Idempotent on the source record id.
5. Record a `fetch_run`.
6. Mark affected timeline frames dirty.

The frame builder runs debounced, 5 s after the last webhook.

### Backfill

A one-off Bun script run on the VM loads:
- 30 days of iNat, Open-Meteo archive, USGS, CO-OPS and NWS data;
- 5 years of NAS and GBIF for the baseline.

### Firecrawl (optional)

Firecrawl monitors with webhooks can watch non-API sources, such as FWC python program pages and news, into the same receiver as `source=web`. This is a stretch goal.

## 7. Data model

### `observations.db` (written only by ingest)

```
sources          id, name, homepage, cadence_s, max_latency_s
fetch_runs       id, source_id, fetched_at, received_at, status(ok|empty|error|partial),
                 http_status, rows_in, raw_object_id, error
raw_objects      id, r2_key UNIQUE, source_url, fetched_at, bytes, sha256
taxa             id, scientific_name, common_name, focus BOOLEAN
sightings        id, source_id, ext_id, taxon_id, lat, lon, accuracy_m, observed_at,
                 quality(research|needs_id|casual|curated), photo_url, raw_object_id,
                 canonical_id NULL          -- set when deduped to another sighting
                 UNIQUE(source_id, ext_id)
sighting_revisions sighting_id, changed_at, field, old, new   -- iNat ID flips etc.
stations         id, source_id, ext_id, name, lat, lon, kind(buoy|gage|tide|grid)
readings         station_id, param(air_c|water_c|sst_c|rain_mm|stage_m|wave_m|wind_ms),
                 value, observed_at, origin(measured|modeled), raw_object_id
                 PK(station_id, param, observed_at, origin)
alerts           id, ext_id, event, severity, area_geojson, onset, expires, headline, raw_object_id
frames           cell_level, frame_at, payload BLOB   -- columnar: sightings, scores, readings
```

### Data quality

| Case | Detection | Treatment |
|---|---|---|
| Stale feed | now − newest `observed_at` > `max_latency_s` | Feed-state chip (nominal/lagging/stale/down), after God's Eye View `feedState.js`. Every agent tool result carries the envelope, and the agent must state it. |
| Missing | fetch_run error/empty; station silent for an expected interval | Hatched gap on the timeline. No interpolation. |
| Duplicate | GBIF record whose `catalogNumber` is an iNat id; NAS record within 50 m / 24 h of the same taxon | `canonical_id` links them. The UI shows one pin with an "also reported by" list. |
| Conflicting | iNat ID changed after ingest; modelled SST vs buoy differ > 1.5 °C; research vs needs_id | A revision row plus a conflict badge. The agent prefers measured and research grade, and names the disagreement. |
| Late | NAS/GBIF arrive weeks after the observation | Placed at `observed_at`. The drawer shows the ingest lag. |

## 8. Hotspot score (explainable heuristic)

`packages/hotspot` holds pure functions shared by server and client.

For each grid cell (0.01°, about 1 km) and time *t*:

```
score = density(t) × activity(species, conditions(t)) × access(species, conditions(t))
```

| Term | What it is |
|---|---|
| density | Kernel-weighted recent sightings, with a per-species half-life (python 21 d, iguana 14 d, tegu 14 d, lionfish 60 d). NAS/GBIF history is weighted 0.2 as a prior. |
| activity | Per-species rule table in `rules.ts`, each rule citing its rationale. Examples: python favours warm nights (air 21–32 °C); iguana cold-stun below 10 °C marks an easy-capture window; tegu activity drops Oct–Feb; lionfish is year-round. |
| access | Whether crews can work. Examples: lionfish needs wave < 1.2 m and wind < 8 m/s; python search is levee-road bound, so drier stage helps. |

- **Explain panel:** the UI shows each term's contribution for any cell. The agent can call it too.
- **Backtest panel:** for each day D, score cells using data before D, then measure what share of D's sightings fell in the top 10 % of cells, against the 10 % random baseline. It's shown honestly, even if the result is weak.

## 9. GraphQL surface (sketch)

```graphql
type Query {
  feeds: [FeedState!]!
  sightings(bbox: BBox!, from: Time!, to: Time!, taxa: [ID!]): [Sighting!]!
  readings(bbox: BBox!, from: Time!, to: Time!, params: [Param!]): [Reading!]!
  alerts(bbox: BBox!, at: Time!): [Alert!]!
  frames(bbox: BBox!, from: Time!, to: Time!, stepMinutes: Int!): FrameChunk!   # columnar
  hotspots(species: ID!, at: Time!, bbox: BBox!): HotspotGrid!
  explainCell(cell: ID!, species: ID!, at: Time!): HotspotExplain!
  backtest(species: ID!, days: Int!): Backtest!
  evidence(id: ID!): Evidence!
  board(id: ID!): Board!
  opsSince(boardId: ID!, seq: Int!): [Op!]!
}
type Mutation {
  ask(question: String!, view: ViewInput): AskHandle!
  applyOps(boardId: ID!, ops: [OpInput!]!): ApplyResult!
}
type Subscription {
  answer(askId: ID!): AnswerChunk!
  ops(boardId: ID!, afterSeq: Int!): Op!
}
```

## 10. Agent (low runtime budget)

### Pattern

The pattern comes from God's Eye View's analyst engine and tool schemas.

- Tools run in-process against the same service layer as the resolvers.
- Every result row carries `{kind, id}`, so the UI can highlight it.
- Every result includes the feed-state envelope.

### Tools

| Tool | Returns |
|---|---|
| `geocode(place)` | Place name → coordinates. Local gazetteer of Everglades units, Keys and marinas first, then Open-Meteo geocoding. |
| `sightings(bbox, from, to, taxa?, quality?)` | Sightings in the area and window. |
| `conditions(bbox, at)` | Weather, water and sea conditions. |
| `alerts(bbox, at)` | Official alerts in effect. |
| `hotspots(species, at, bbox)` | Top cells, with their explanations. |
| `explain_cell(cell, species, at)` | Each term's contribution to one cell's score. |
| `backtest(species, days)` | How well past scores predicted later sightings. |
| `feed_state()` | Current state of every feed. |
| `set_view(bbox, time)` | Drives the globe and timeline. |

### Grounding

- Claims cite `[e:<id>]`.
- The server keeps a set of ids returned by tools in this run. Any citation outside it is stripped, and the answer is flagged "unverified claim removed".
- The system prompt requires stating staleness, conflicts, and the heuristic nature of hotspots.

### Cost controls

- The tool loop runs on a small, fast Claude model. A larger model is used only when a question needs multi-step synthesis. Exact model ids and pricing get confirmed with the `claude-api` skill at build time.
- Prompt caching covers the system prompt and tool definitions.
- An answer cache is keyed by (normalized question, data version).
- A server-side daily spend cap (default $3) uses token accounting. When it's hit, the UI falls back to "cached answers + direct query".

### Eval

`bun run eval` runs about 15 golden questions against a frozen fixture DB. It checks the expected tools were called and the citations are valid.

## 11. Client

### Globe (CesiumJS + Cesium ion Community)

- **Setup:** CesiumJS assets are copied to `public/cesium` and `CESIUM_BASE_URL` is set. The viewer is created once in a client-only component. Widgets are hidden; our React HUD replaces them.
- **Imagery ladder** (after God's Eye View `src/maps/imagery.js`):
  - Google Photorealistic 3D over Miami and the Keys, and Bing aerial imagery everywhere else, both through ion.
  - Cesium World Terrain, plus bathymetry if the Community tier includes it.
  - Keyless Esri/OSM fallback, switched automatically when a quota counter in `team.db` nears the Community limit (1,000 root tiles and 1,000 imagery sessions a month).
- **Layer contract:** each layer implements `init / enable / disable / update(frame) / stats`, after God's Eye View's `src/layers/earthquakes/index.js`. Layers:
  - sightings: a `PointPrimitiveCollection` with a billboard per focus species;
  - hotspot heatmap: a canvas texture drawn from the SAB grid, on a ground rectangle;
  - stations with readings;
  - alert polygons;
  - mission markers;
  - peer cursors.
  - Primitives are used, not Entities, for thousands of points.
- **Render governor:** `requestRenderMode` is on when idle, and the layers ref-count their animation needs (after `src/renderGovernor.js`).
- **Clock:** the Cesium clock is slaved to the `TIME` active-state key, and the timeline scrubber drives both.
- **HUD** (after God's Eye View `hud.js`, `detection.js`, `labelArbiter.js`):
  - top bar: feed-state chips, UTC and local clock, cursor coordinates;
  - detection brackets and labels on cited or selected entities, with label collision arbitration;
  - a scope-mask focus mode for mission view.
- **Share links:** URL hash state (camera, time, layers, selection), after `src/sharelink.js`.

### Theme and state

- **Theme:** `active-theme` with modes `light`, `dark` and `tactical` (dark, green/amber HUD accents). Palettes are ported from big-value `client/themes/tokens.ts`. A pre-paint bootstrap in `layout.tsx` sets `data-theme` (manhwa-ai pattern).
- **State:** `@calvinjs/active-state` keys in `client/state/` (`TIME`, `VIEW`, `LAYERS`, `SELECTION`, `ASK`, `FEEDS`, `BOARD`, `PEERS`, `ME`), mounted once via `<ActiveState init={state} ssr />`.

### New tech 1: threaded active-state (`packages/active-state`, subpath `./threads`)

The fork is a git subtree of CalvinMaighan/active-state on branch `threads`, to be pushed upstream as v0.2. The public API doesn't change: `key` / `get` / `set` / `subscribe` / `useActiveState` work from any thread.

**Threads:**

| Thread | Owns |
|---|---|
| main | React, Cesium, the `RTCPeerConnection` shell (workers can't construct one) |
| gql worker | GraphQL fetch, SSE subscriptions |
| db worker | sqlite-wasm, CRDT, frame and hotspot computation |
| rtc worker | Transferred `RTCDataChannel`s (Chrome/Edge 130+, Safari 15+). On Firefox, main relays bytes through the ring. |

**Transport:** one `SharedArrayBuffer` per thread pair, holding:
- an `Int32Array` control block (cursors, plus a version per key index);
- an SPSC byte ring of `(keyIndex, len, bytes)` frames, JSON-encoded via `TextEncoder`. Msgpack only if profiling says so.

Writers bump the version and call `Atomics.notify`. Readers wait with `Atomics.waitAsync` on main and `Atomics.wait` in workers.

**Bulk data:** the db worker writes timeline frames and the hotspot grid into `Float32Array` views over a SAB. Cesium layers read them on main with no copy or decode, and scrubbing never touches the network.

**Isolation:**
- Headers: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. `credentialless` isn't supported in Safari.
- Cesium ion and Google tiles load as CORS requests.
- iNat photos and other third-party media go through `/api/media`, same origin and R2-cached.
- Fonts are self-hosted. There are no iframes.

**Fallback:** a `postMessage` transport with the same API, chosen at boot when `crossOriginIsolated` is false.

### New tech 2: local SQLite + CRDT + optimistic rendering

**Engine:** `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS in the db worker. A Web Locks leader tab owns it, and other tabs proxy over `BroadcastChannel`. IndexedDB (wa-sqlite `IDBBatchAtomicVFS`) is a fallback only if OPFS is missing.

**Local tables:**
- `cache_frames` (by cell range + frame range, with ETag)
- `cache_queries` (query hash → rows, TTL by feed cadence)
- `ops`
- materialized `missions`, `notes`, `messages`
- `outbox`

**Read path:** stale-while-revalidate. The db worker answers from cache at once. The gql worker revalidates, the db worker upserts, and the key's version bump re-renders.

**CRDT (`packages/crdt`):**
- An op is `{id, hlc(wallMs, counter, nodeId), entity, entityId, field, value}`.
- Missions and notes are last-writer-wins per field. Deletes are tombstones.
- Messages are append-only, ordered by HLC.
- Removal counts are a grow-only counter per node, so concurrent increments add instead of overwriting.
- `apply(db, op)` is idempotent on `id` and runs on both server (`bun:sqlite`) and client (sqlite-wasm) behind a two-method `Db` interface.

**Write path:**
1. The user edits.
2. The db worker applies the op, and the UI renders in the same frame.
3. The rtc worker broadcasts to peers (under 150 ms).
4. The gql worker sends `applyOps`. The server assigns a `seq`, persists, and fans out over SSE.
5. The outbox entry is marked acked.

On reconnect, the client pulls `opsSince(lastSeq)`. The server is the durable truth, and RTC is only the fast path.

### New tech 3: WebRTC signaling on Cloudflare Workers + R2

**Rooms:** one room per board, in a mesh of up to 8 peers.

**Worker endpoints:**
- `POST /rooms/:room/peers` announces a peer (60 s heartbeat).
- `GET /rooms/:room/peers` lists the peers in a room.
- `POST /rooms/:room/inbox/:peer` delivers an offer, answer or ICE batch.
- `GET /rooms/:room/inbox/:peer` polls, then deletes.
- `GET /turn` mints short-lived Cloudflare Realtime TURN credentials.

**R2:**
- R2 gives strong read-after-write consistency.
- The peer list uses `onlyIf` etag puts.
- A lifecycle rule deletes objects after 1 day.

**Polling:** at 500 ms, only during handshake. After that, all traffic, including renegotiation, rides the DataChannel.

**Tradeoff:** R2 can't push. Durable Objects with WebSocket hibernation would be faster and are the documented upgrade, behind the same client interface.

### UI layout

- **Globe:** full-bleed.
- **Left panel:** ask bar, answer stream, citations.
- **Right drawer:** evidence.
- **Bottom:** timeline scrubber with gap hatching, alert bands and a sighting-density sparkline.
- **Top HUD:** feed-state chips.
- **`/board/[id]`:** mission cards, removal totals, chat, peer presence.
- **Mobile:** usable at 375 px. Panels become sheets.

## 12. Performance targets

| Interaction | Target |
|---|---|
| Scrub frame change | < 16 ms (SAB, no network) |
| Cached query (client SQLite) | < 20 ms |
| First answer token | < 2 s p50 |
| Optimistic edit, local | same frame |
| Edit to RTC peer | < 150 ms p50 |
| Edit via SSE fallback | < 1 s p50 |
| Freshness vs upstream | ≤ feed cadence + 2 min |
| Globe idle CPU | ~0 (request-render mode) |

## 13. Deployment and cost

- **Hetzner:** one CX22-class VM (Ubuntu 24.04), about €4–5/mo. Caddy handles TLS for `inversa.calvinmaighan.dev` and sets COOP/COEP.
- **systemd:** `inversa-web` and `inversa-litestream`. There is no ingest daemon; ingest arrives by webhook. Layout comes from big-value `deploy/`.
- **Restore:** `litestream restore` on boot if the DBs are missing, so the VM is disposable. The restore drill is a milestone gate.
- **Cloudflare (free tier):**
  - two Workers via wrangler: `ingest-worker` and `signal-worker`;
  - R2 buckets `inversa-raw`, `inversa-litestream` and `inversa-signal` (1-day lifecycle);
  - DNS for `calvinmaighan.dev`.
- **Cesium ion Community:** free for this personal demo. If Inversa adopted the tool internally, a paid ion plan would apply.
- **CI (GitHub Actions):**
  - `check.yml` runs lint, typecheck and `bun test`.
  - `deploy.yml` builds, then SSH, rsync and a systemd restart.
  - `workers.yml` runs `wrangler deploy`.
  - Secrets come from Doppler, as in big-value.
- **Secrets:** `ANTHROPIC_API_KEY`, `INGEST_HMAC_SECRET`, `CESIUM_ION_TOKEN`, the R2 key pair, the Cloudflare TURN key, and the Hetzner SSH key.
- **Expected monthly cost:** about €5 for the VM, $0 for Cloudflare (free tier), $0 for ion, plus LLM tokens capped at about $3/day.

## 14. Plan: 10 working days, one senior developer

| Day | Deliverable | Done when |
|---|---|---|
| 1 | Scaffold + deploy skeleton | Monorepo, subtrees, theme modes, CI green; Hetzner + Caddy + Litestream serving a hello page at the domain with COOP/COEP (`crossOriginIsolated === true`) |
| 2 | Ingest path | ingest-worker cron + R2 archive + signed webhook; receiver; iNat + Open-Meteo adapters with fixture tests; feed-state live |
| 3 | Remaining feeds + quality | NAS, GBIF, NDBC, CO-OPS, USGS, NWS; dedupe, revisions, conflict flags; 30-day backfill run |
| 4 | Read API + globe | GraphQL queries; Cesium viewer, imagery ladder, sightings/stations/alerts layers, render governor |
| 5 | Timeline + hotspots + evidence | Frame builder, scrubber, hotspot heatmap + explain panel, evidence drawer to raw payload, share links |
| 6 | Agent | Tool loop, citation checker, feed-state envelope, streaming over SSE, budget guard, eval set passing |
| 7 | Threaded client | active-state `./threads` (SAB ring + fallback) with tests; gql + db workers; sqlite-wasm cache; SAB frames feeding Cesium |
| 8 | Team board | CRDT package with tests; missions, notes, removal counters; optimistic writes, `applyOps`, SSE fan-out, `opsSince` recovery |
| 9 | WebRTC | signal-worker + R2 + TURN; rtc worker with transferred channels; chat and op fast path; Firefox relay |
| 10 | Ship | HUD polish (brackets, scope focus), backtest panel, perf pass against targets, restore drill, README, demo script, interview notes |

If time runs short, cut from this list in order. The brief's requirements stay whole:

1. Firecrawl web source.
2. Voice input.
3. Firefox rtc relay (Firefox falls back to SSE).
4. Multi-tab leader election (single tab plus a notice).
5. The rtc worker (DataChannels stay on main).
6. Google 3D tiles (Bing imagery only).

Days 1–6 and 10 are non-negotiable.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Sparse live sightings on demo day | 30-day window + 5-year baseline; a recorded fixture of a known event (a recent winter cold snap with iguana cold-stun reports; date to be picked from the backfill) for the demo script |
| ion Community quota exhausted by reviewers | Quota counter + automatic keyless imagery fallback |
| COEP blocks a resource | require-corp with same-origin media proxy; boot check falls back to the postMessage transport |
| Worker 10 ms CPU limit | Worker only fetches and streams; parsing on Hetzner; $5 Workers Paid as escape hatch |
| iNat rate etiquette | 1 req/s governor, `updated_since` cursors, backoff on 429 |
| Heuristic hotspots look like overclaiming | Explain + backtest panels; agent must label them as heuristic |
| OPFS single-connection | Web Locks leader, or a single-tab notice |
| Scope | Cut order above; each new-tech layer sits behind an interface with a simple fallback |

## 16. Scaling story (for the interview)

- **More regions or species:** a region is a bbox plus a taxa list, and a species is a rules entry. Lionfish Caribbean (Belize, Colombia, Mexico) and carp in the Mississippi basin are config plus adapters.
- **More data:**
  - partition observations by month into attached SQLite files, or move analytics to ClickHouse/Timescale;
  - frames become immutable R2 chunks behind the CDN.
- **More traffic:** stateless web behind a load balancer, with read followers from Litestream. Ingest is already serverless.
- **More users per board:** an SFU (Cloudflare Realtime) instead of the mesh, and Durable Objects for signaling.
- **Field integration:** the Origin analogue. The body-cam and drone detections Inversa already has would be another sightings source with `quality=ai_confirmed`, feeding the same evidence and hotspot pipeline.
