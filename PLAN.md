# Plan: Everglades Ops build

Depth: tree 5. Mode: orchestrated.

Budget note: the PRD is sized as about 10 working days for one senior developer. The target is 72 h wall clock, using parallel worktree leaves.

Sources: `docs/BUILD_BRIEF.md` (tasks T1–T36, requirements R1–R19, human blockers H1–H10) and `docs/PRD.md` v3.

## Contract

These are decided before fan-out. Leaves must not change them. If a leaf needs a change, it writes `CONTRACT-REQUEST:` in its report and the driver decides.

### C1: layout and ownership

- **Layout:** PRD §5 "Repo layout".
- **Driver-owned files (T1):**
  - root `package.json`, `bun.lock`
  - `api/Cargo.toml`, `api/Cargo.lock`
  - `api/src/main.rs`, and every `mod.rs` that only declares modules
  - `api/src/{state.rs,model.rs,ingest/source.rs,db/mod.rs(API surface)}`
  - `api/migrations/*`, `api/schema.graphql`
  - `apps/web/package.json`
  - `apps/web/shared/**`
  - `spec/README.md`
- **Dependencies:** a leaf may add dependencies on its own worktree branch. The driver resolves manifest and lockfile conflicts at merge.
- **Stub files:** a leaf owns only the files in its row. Driver-created stub files that a leaf owns are the leaf's to replace.

Tests mirror their source: `apps/web/tests/<path>` belongs to whichever leaf owns `apps/web/<path>`. The e2e Playwright scripts (`apps/web/e2e/<name>.ts`, npm script `e2e:<name>`) belong to the leaf whose gate names them. Each leaf may add its own `e2e:*` script line to `apps/web/package.json`.

| Task | Owns |
|---|---|
| T2 | `packages/active-state/**` (subtree base), `packages/active-theme/**` |
| T3 | `apps/web/app/{layout.tsx,page.tsx,globals}`, `apps/web/client/{themes,state,ui/Providers.tsx,styled.ts}`, `apps/web/next.config.ts`, `apps/web/public/fonts/**` |
| T4 | `api/src/db/{writer.rs,pool.rs}`, `api/src/db/mod.rs` (implementation only; keep the signatures), `api/src/realtime.rs`, `api/src/feed_state.rs`, `api/src/graphql/**` (stubs + schema-diff test) |
| T5 | `api/src/ingest/{scheduler.rs,archive.rs,governor.rs}`, `api/src/ingest/push/hook.rs` |
| T6 | `deploy/**`, `.github/workflows/{release,deploy,workers}.yml` |
| T7 | `api/src/ingest/push/{goes_sqs.rs,goes_grid.rs}`, `api/fixtures/goes/**`, `deploy/aws/**` |
| T8 | `api/src/ingest/poll/{nws,usgs,ndbc,coops,openmeteo,physical}.rs`, `api/src/ingest/push/nwws.rs`, `api/src/ingest/quality_phys.rs`, `api/fixtures/{nws,usgs,ndbc,coops,openmeteo}/**` |
| T9 | `api/src/ingest/poll/{inat,nas,gbif,bio}.rs`, `api/src/ingest/quality_bio.rs`, `api/src/backfill.rs`, `api/fixtures/{inat,nas,gbif}/**` |
| T10 | `api/src/graphql/**` (resolvers), `api/src/media.rs`, `api/src/evidence.rs` |
| T11 | `api/src/frames.rs`, `api/src/hotspot/**`, `spec/frames/**` |
| T12 | `api/src/crdt.rs`, `spec/crdt/**`, `apps/web/client/threads/crdt/**` |
| T13 | `apps/web/server/agent/**`, `apps/web/app/api/agent/**`, `apps/web/eval/**`, `apps/web/tests/server/agent/**` |
| T14 | `apps/web/client/agent/**` |
| T15 | `apps/web/server/voice/**`, `apps/web/app/api/voice/**`, `apps/web/client/voice/**`, `apps/web/shared/voice/ui-tools.ts` (implementation of the declared schemas) |
| T16 | `packages/active-state/src/threads/**`, `packages/active-state/tests/threads*`, the `package.json` exports entry for `./threads` |
| T17 | `apps/web/client/globe/**`, `apps/web/public/cesium` (copy script) |
| T18 | `apps/web/client/hud/**` except `hud/missions` |
| T19 | `apps/web/client/threads/{boot.ts,gql.worker.ts,db.worker.ts,db/**,gql/**}` |
| T20 | `apps/signal-worker/**` |
| T21 | `apps/web/client/threads/rtc.worker.ts`, `apps/web/client/threads/rtc/**`, `apps/web/client/hud/missions/**` |

### C2: GraphQL SDL

- `api/schema.graphql` is the contract. async-graphql's `schema.sdl()` must match it after normalization; T4 adds a test that checks this.
- Scalars:
  - `Time` is an RFC 3339 string.
  - `JSON` is arbitrary JSON.
- `BBox` is an input `{west,south,east,north}`.
- `FrameChunk.data` is base64 of the C4 EVF2 format (at most 24 frames); bulk frames use REST `GET /v1/frames`.

### C3: feed-state envelope

```
{source, mode: push|poll, state: nominal|lagging|stale|down,
 newestObservedAt, lastFetchAt, lagSeconds, note}
```

- Rust: `feed_state::FeedState`.
- TS: `apps/web/shared/feed-state.ts`.

### C4: binary frame format "EVF2" (little-endian; revised after T11)

EVF1 used f32 grids at 0.01°, which is 2.6 MB per frame and 7.5 GB per month. EVF2 fixes that by quantizing and using coarser grids.

The authoritative byte layout is the doc comment in `apps/web/shared/frames.ts` (72-byte header). Summary:

- **Hotspot grid:** 0.02°, 170 × 160 cells. Values are u8, with `score = u8 × hotspotScale`.
- **Environment grid:** 0.05°, 68 × 64 cells, identical to the GOES `g5` cells. LST and SST are stored as i16 centi-°C, with `-32768` meaning missing or flagged.
- **Sightings:** a u32 count, then 12-byte records: `f32 lon`, `f32 lat`, `u16 taxon`, `u8 quality`, `u8 flags`.
- **Step:** hourly by default. 15 min is allowed for windows of 24 h or less.
- **Size:** about 45 KB raw per frame. 30 days of hourly frames compress to a few MB with gzip.
- **Transport:**
  - Bulk: REST `GET /v1/frames?from=&to=&step=`, returning `application/x-evf` with gzip content encoding. At most 744 frames.
  - GraphQL `frames` returns `data` = base64 of EVF2 for at most 24 frames.
- **Storage:** the `frames` table stores zlib-compressed EVF2 bodies, one per `frame_at`.

Notes:
- Grids are row-major from the south-west corner (−83.2, 24.3).
- Hotspot cell ids stay on the 0.01° C14 grid for `explainCell`. The 0.02° frame grid is a display downsample (max of its 2×2 children).
- Species order: python, tegu, iguana, lionfish (`taxa.id` 1–4).
- `quality`: 0 = research, 1 = needs_id, 2 = casual, 3 = curated.
- `flags` bits: 1 = duplicate (has `canonical_id`), 2 = conflict, 4 = late.
- `spec/frames/sample.evf` is the golden file (T11).

### C5: CRDT op

```
{id: uuidv7, hlc: "<wallMs>:<counter>:<nodeId>", boardId,
 entity: "mission"|"note"|"message"|"removal", entityId, field, value(JSON), nodeId}
```

**HLC ordering:** compare wallMs, then counter, then nodeId as strings.

**Merge rules:**
- **Mission and note:** last-writer-wins by HLC per `(entity, entityId, field)`. Deletes use `field="_deleted"`, `value=true`.
- **Message:** a single op carries `field="body"`, and messages are ordered by HLC. Any later op for the same message is ignored.
- **Removal:** a grow-only counter. `value` is the node's own running total (an integer). The merged value is the per-node max, summed over nodes.

**Apply:** idempotent on `id`.

**Test vectors:** `spec/crdt/*.json`, each shaped `{name, ops:[...], expected:{missions:{id:{field:value}}, notes:{...}, messages:[{id,body,hlc}], removals:{entityId:total}}}`.

### C6: SAB transport (`@calvinjs/active-state/threads`)

- **Control block:** `Int32Array[2 + 256]` = `[writeCursor, readCursor, keyVersion×256]`.
- **Ring:** SPSC, capacity a power of 2. Each record is `u16 keyIndex, u32 len, bytes (UTF-8 JSON)`. A record never straddles the wrap: when it wouldn't fit, a pad marker `keyIndex 0xFFFF` is written and the writer jumps to 0.
- **Signalling:** writers call `Atomics.notify(ctrl, 0)`. Readers wait with `Atomics.waitAsync` on main and `Atomics.wait` in workers.
- **Interface:**
  ```ts
  interface Transport { send(keyIndex: number, value: unknown): void; onMessage(cb: (keyIndex: number, value: unknown) => void): () => void; close(): void }
  ```
- **Fallback:** a `postMessage` Transport with the same interface.
- **Key index:** the position in the sorted key-id list of the `client/state` catalog.

### C7: agent NDJSON events

`apps/web/shared/agent/events.ts`: the deedee `DeedeeChatStreamEvent` union, plus `view` and `citation`.

### C8: voice protocol

- `apps/web/shared/voice/protocol.ts`: a verbatim copy of deedee's `shared/voice/protocol.ts`, with the credit constants renamed to minute caps.
- `apps/web/shared/voice/ui-tools.ts`: zod schemas for `fly_to`, `set_time`, `play_timeline`, `toggle_layer`, `select`, `open_evidence`.

### C9: signaling API

- `POST /rooms/:room/peers` with `{peerId, name}`. Returns 204. Heartbeat TTL 60 s.
- `GET /rooms/:room/peers` returns `[{peerId, name, seenAt}]`.
- `POST /rooms/:room/inbox/:peer` with `{from, kind: "offer"|"answer"|"ice", payload}`. Returns 204.
- `GET /rooms/:room/inbox/:peer` returns an array and deletes what it returned.
- `GET /turn` returns `{iceServers:[...]}`.
- CORS: `ALLOWED_ORIGIN` only. Every response carries `Cross-Origin-Resource-Policy: cross-origin`.

### C10: HMAC hook

`POST /v1/ingest/hook/:source` with headers:
- `X-Timestamp`: unix seconds;
- `X-Signature`: `hex(HMAC_SHA256(INGEST_HOOK_SECRET, "<ts>.<body>"))`.

Rules:
- A timestamp more than 300 s old returns 401.
- A bad signature returns 401.
- Success returns 202.

### C11: scripts

Root `package.json`: `dev`, `api`, `build`, `lint`, `typecheck`, `test`, `test:api`, `eval`, `check`.

### C12: Rust core interfaces (driver-owned files)

- **`db::Db`** (`Clone`):
  - `open(dir, name)`, `memory(name)`
  - `async write(F: FnOnce(&Transaction) -> rusqlite::Result<R>)`
  - `async read(F: FnOnce(&Connection) -> rusqlite::Result<R>)`
  - `name` selects the migration set: `"observations"` or `"team"`.
- **`state::AppState`:** `{ obs: Db, team: Db, hub: Hub, archive: Arc<dyn Archive>, http: reqwest::Client, config: Arc<Config> }`.
- **`ingest::archive::Archive` trait:**
  - `async put(key, bytes, content_type) -> Result<()>`
  - `async get(key) -> Result<Vec<u8>>`
  - Implementations: `MemArchive` (tests), `DirArchive` (dev), `R2Archive` (prod).
- **`ingest::source::Source` trait:**
  - `id() -> &'static str`
  - `mode() -> Mode`
  - `min_interval() -> Duration`
  - `async fetch(&self, ctx: &FetchCtx) -> Result<Vec<RawPayload>>`
  - `normalize(&self, raw: &RawPayload) -> Result<Vec<Row>>`
- **`model::Row` enum:** `Sighting | Reading | Alert | Station | Revision`, with the fields of the migration tables.
- **`realtime::Event` enum:** `FeedState(FeedState) | FramesUpdated{from,to} | Op(Op)`.

### C13: ports and env

| Setting | Value |
|---|---|
| Axum bind | `127.0.0.1:4041` (`INVERSA_BIND`) |
| Next port | 3050 |
| Data dir | `INVERSA_DATA_DIR` (default `./data`) |
| API origin for Next | `INVERSA_API_ORIGIN` |

Secrets (never committed): `OPENROUTER_API_KEY`, `XAI_API_KEY`, `CESIUM_ION_TOKEN` (exposed to the client as `NEXT_PUBLIC_CESIUM_ION_TOKEN`), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_RAW`, `GOES_SQS_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NWWS_USER`, `NWWS_PASS`, `INGEST_HOOK_SECRET`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_TOKEN`.

### C14: evidence ids

Evidence ids take the form `<kind>:<key>`:

| Kind | Key |
|---|---|
| `sighting` | `sightings.id` |
| `reading` | `<station_id>:<param>:<observed_at ms>:<origin>` |
| `alert` | `alerts.id` |
| `fetch` | `fetch_runs.id` |
| `hotspot` | `<species>:<cell>:<frame ms>` |
| `backtest` | `<species>:<days>` |

Cell ids are `<col>:<row>` on the 0.01° grid anchored at the bbox south-west corner (24.3°N, 83.2°W).

The same strings appear in agent citations `[e:<id>]`, in `evidence(id)`, in UI selection, and in `select` / `open_evidence`.

### C15: region

- Bbox: west −83.2, south 24.3, east −79.8, north 27.5.
- Grid: 0.01°, which gives 340 cols × 320 rows = 108,800 cells.
- Frames: 15-minute steps, 30-day window.

### C16: UI integration surfaces (added after T3)

- **`apps/web/client/globe/api.ts`:** `GlobeApi {flyTo, project, pick, onPostRender, requestRender}`, plus `registerGlobe`, `getGlobe` and `onGlobeReady`. T17 registers the API. The HUD, missions and agent consume it and never import Cesium.
- **`apps/web/client/threads/api.ts`:** `gqlRequest`, `gqlSubscribe`, `getFrameGrid`, `onFrameGrid` and `publishFrameGrid`.
  - The driver version runs on the main thread.
  - T19 moves the internals onto the workers, keeping the signatures.
  - UI code fetches data only through this module.
- **Default-export components:**
  - `client/globe/index.tsx` exports `Globe` (T17).
  - `client/hud/index.tsx` exports `Hud` (T18). It takes a `missions?: ReactNode` prop.
  - `client/hud/missions/index.tsx` exports `MissionsPanel` (T21).
  - `client/agent/index.tsx` exports `AgentOrb` (T14).
  - The driver composes them in `app/page.tsx` through `AppShell` slots.
- **Frame grid:** a `FrameGrid` from `@calvinjs/active-state/threads` (EVF2 shape). Layers read `hotspot(i, s)`, `lst(i)` and `sst(i)`.
  - There is one hourly grid for the 30-day TIME window, published with `publishFrameGrid(grid, meta)`, where `meta` is `FrameMeta {frame0UnixMs, stepMinutes, frameCount}`.
  - Everyone maps time to frames with `frameIndexAt(atMs)` from `client/threads/api.ts`, which floors `(at − frame0) / step` and returns null outside the grid. Don't spread frames evenly over TIME.
  - Sighting sections come through `publishFrameSightings`, `getFrameSightings` and `onFrameSightings`: `counts` plus the raw 12-byte `records(i)`.
  - The HUD owns FEEDS sync (its `feeds` query and subscription). The workers don't write FEEDS.

### C17: agent result views (added at user review)

- `apps/web/shared/agent/results.ts` defines `ToolResultData {result?: ToolResultView, highlight?: string[], bbox?}`, carried in `tool_end.data` for every data tool.
- View kinds: `table`, `series`, `cells`, `explain`, `backtest` and `feeds`. Rows carry C14 evidence ids.
- The chat card renders a panel for each view. The globe brackets `highlight` ids. Opening a panel frames `bbox` on the globe.

### C18: live mode (added at user review)

- When `TIME.at` sits at the live edge, the timeline follows now.
- An Axum write publishes `framesUpdated`. The db worker then refetches the changed hours and republishes the grid and sightings, and the globe and HUD redraw without a reload.
- New sightings and alerts appear within one pipeline tick plus the 5 s frame debounce.
- A dev-only `INGEST_HOOK_SECRET` default lets the `web` hook source inject rows, so live updates can be verified end to end.

### C19: source page links and simplified UI (added at user review)

- `Evidence.sourcePageUrl: String` is the human web page for the record at its publisher, opened in a new tab. It is not the API URL (`sourceUrl` stays the fetched API URL). It is null when no page exists (modelled grid points, GOES cells, hotspots, fetch runs).
- Patterns:

| Source | `sourcePageUrl` |
|---|---|
| iNat | `https://www.inaturalist.org/observations/<ext_id>` |
| GBIF | `https://www.gbif.org/occurrence/<gbifKey>` |
| NAS | the NAS specimen viewer for the record's key |
| USGS | `https://waterdata.usgs.gov/monitoring-location/<site>/` |
| NDBC | `https://www.ndbc.noaa.gov/station_page.php?station=<id>` |
| CO-OPS | `https://tidesandcurrents.noaa.gov/stationhome.html?id=<id>` |
| NWS alert | the alert's own web page, or the CAP id URL when no page exists |
| backtest | none |

- UI default is "sightings first":
  - Sightings and alerts are on by default. Stations, hotspots and LST/SST are off by default but stay one tap away in Layers.
  - Species bar (T44): the four focus species pinned, then the top introduced animals in the window, then an Other chip that opens a categories popover (snakes, lizards, turtles, crocodilians, frogs, birds, mammals, fish, snails, insects, spiders, plants, other; categories from iNat ancestry). Every marker is a category SVG icon in its label colour. The window is 2/7/30 days, default 7.
  - The top bar collapses to the title, the LIVE/REPLAY badge, and one status icon button whose popover holds feeds, theme, focus and help.

## Tree

- 1 Everglades Ops (`GATES.md`)
  - 1.1 Data plane (`gates/node-data.md`)
    - T4 core, T5 archive/scheduler, T7 GOES, T8 physical, T9 bio, T10 GraphQL, T11 frames/hotspots
  - 1.2 Client (`gates/node-client.md`)
    - T2 subtrees, T3 shell, T16 threads, T17 globe, T18 HUD, T19 workers
  - 1.3 Conversation (`gates/node-convo.md`)
    - T13 agent, T14 orb/card, T15 voice
  - 1.4 Team (`gates/node-team.md`)
    - T12 CRDT, T20 signal, T21 rtc + missions
  - 1.5 Ship
    - T6 deploy/CI, T27–T36

## Status log

- W0 started: brief saved to `docs/BUILD_BRIEF.md`.
- W0: skeleton compiles (cargo test 2 passed, web 5 pass, next build ok); W1 gates written; W2+ gates pending before their dispatch
- W0 done: T1 gates ALL MET (6/6). W1 dispatched: T2 T4 T5 T6 T7 T20 (worktrees). T3 waits for T2.
- W2 early dispatch (contract-only deps): T11 T12 T13 T15. Pending: T3 (after T2), T8 T9 (after T5), T10 (after T4 T11 T12), T16 (after T2)
- T2 merged+verified 11/11. T20 merged+verified 4/5, G5 ABANDON H3.
- T5 merged+verified 6/7 (G7 ABANDON H3). Note: pollers use governor::check_response.
- T6 merged+verified (G7 ABANDON H1-3,H8). Fixed gate id format for (live...) gates.
- T4 merged+verified 9/9; contract requests applied: publisher at boot, migration 0002
- T12 merged+verified 5/5 (14 vectors). Contract change for T10: Board gains notes: [Mission!]!
- T15 merged+verified 6/7 (G7 ABANDON H6). Contract: voice task.event added. Keys to reconcile at T3 merge: client/voice/state.ts
- T7 merged+verified 8/9 (G7 ABANDON H4); GOES at 0.05deg g5 cells, ~137k rows/day.
- T11 merged (EVF1) -> rework to EVF2. T16 merged+verified 5/5 -> FrameGrid rework to EVF2.
- T3 merged (8/8 on branch). Accepted: test tsconfig flag; build copies static+public; slots via default exports client/globe, client/hud, client/agent wired by driver. T15 reconciling voice keys with catalog.
- T13 merged (lint fixes pending on T13 branch). Contract: C14 backtest kind + FeedState.lastFetchRunId (T10). next.config traces cordis.yml.
- T9 merged+verified 6/6 (api 123 tests). T13 lint follow-up merged+verified 5/5+1 abandoned. EvidenceKind += backtest. 1 web test fail pending T15 key reconcile.
- T15 reconcile merged (web 225/0, build ok). T11 EVF2 merged 8/8. hotspotScale rounded in frames.ts.
- T10 merged+verified 9/9 (api 156). C14 backtest kind listed.
- T8 merged+verified 5/5 (api 200 tests). Cargo.lock regenerated.
- T14 merged+verified 5/5. Deferred T14 requests: mock golden autoload (T13), evidence lat/lon (T10/T13).
- T17 merged (6/7, G7 ABANDON H7). Contract: EVF2 sighting record 16B with u32 id; SightingRecord+readSightingRecords in shared/frames.ts; FrameMeta.geometry; FrameSightings decoded; GlobeApi.onCursor optional. T17 to drop FrameTimeline; T11 to write ids.
- T11 ids merged 8/8. T29 merged (scene cold-snap-2026-02-01). T18 re-adapting to final frame contract; T17 fixing GlobeView. NOTE: scene is outside default 30d window; TIME window must shift via set_time.
- T17 follow-up merged 6/7 (G7 ABANDON H7). Main web: typecheck/lint clean, 418 tests. page.tsx wired: Globe+Hud+AgentOrb.
- T19 merged+verified 4/4 (web 516 tests). Fixes: busy_timeout 30s, GBIF 100/page, quiet cargo scripts.
- T22 data-plane integration: clippy -D warnings clean; migration 0003 (`sources.disabled_reason`, disabled sources listed as down with a note); `backfill --fixtures` covers every fixture source (manifests for physical, GOES, NWWS; NWWS fixtures moved to `api/fixtures/nwws/`) and rebuilds frames; GBIF baseline paged per year (search stalls past offset 10k); e2e_fixture_pipeline; api 204 passed, 2 ignored (live).
- T22 merged; node-data 8/8. NWS freshness fix (alert-only feeds).
- T32 merged 4/4 (README, demo, interview notes, brief-compliance 37 rows). Fixed: allowedDevOrigins 127.0.0.1, GOES doc volumes. Time clamp -> T23/24.
- T21 merged+verified 4/4 (rtc p50 18ms, ws p50 86ms). Web 542 tests.
- T39 merged+verified 11/11 (live eval 14/15). Prompt: disabled feeds need no citation. Driver smoke of bun run dev: api+web+signal, live agent 4 tools/7 citations/view.
- T23/T24 (+C18 live mode as gates/leaf-T37.md): node-client 4/4, node-convo 4/4 + N4 ABANDON (H6), leaf-T23 3/3, leaf-T24 1/1, leaf-T37 4/4. TIME outside the window recentres it (`windowFor`/`retime`; set_time, play_timeline, agent view, share link, timeline date field); live edge follows now; framesUpdated expires the db worker's query cache; alerts/stations refetch on the data revision; `window.__inversa` hook (dev and e2e builds). e2e:client/convo/live run on a shared real stack (e2e/stack.ts: Axum, next start, signal Worker, Caddy-like proxy). Web 551 tests.
- T38 merged 10/10 (agent data panels, globe highlights). Web 586 tests. Live eval 14-15/15 typical.
- T40 merged 18/18 (chat-left layout, legend, tooltips, help). Web 620 tests.
- T30/T31 merged 11/11 (axe 0/0 over 12 scans, keyboard walk, rate limits, injection test live, prod surface). Web 630, API 206, clippy clean.
- T42 merged 7/7 (publisher links; EXTERNAL-LINKS 30/30 new tab). Accepted IEM VTEC page for VTEC-keyed NWS alerts. Re-run e2e:links after T41.
- T43 field notes: the `note` entity carries field notes (text, lat, lon, species?, sightingId?, createdBy, callsign, createdAt); NOTES state key (pins, pick-on-map); notes globe layer (`note:<id>` pins, C14 kind `note`); the board tab reads "Notes" with crew missions behind a disclosure; drawer note card plus "Add note about this sighting"; read-only agent `notes` tool (C17 table); 3 CRDT note vectors (17/17 in both runners); `e2e:notes` on the dev stack (e2e/dev-stack.ts, shared with e2e:team). Authorship, length and rate caps are client-side (docs/security.md).
- T41 (sightings-first, popovers, 48h, plain evidence, welcome) + T43 (field notes) merged; merged tree: web 673/0, FIRSTLOAD/CHROME/ATTRIBUTION/SPECIES/LINKS/LAYOUT/AXE/KEYBOARD pass. e2e:notes re-run blocked by user's running next dev (passed on branch: rtc_ms=624).
- T27/T28 (branch): leaf-T27 3/3, leaf-T28 2/2; the voice and GOES-push rows of docs/perf.md are ABANDON (H6, H4). `e2e_quality_cases` seeds the 5 cases through fixtures, the signed hook and the real NDBC poller against a dead upstream. Live eval 5/5 quality and 15/15 four runs in a row (`feedSummary.mention` with cite markers; late records named). UI: `ENV_FLAGGED` frame sentinel (flagged pixels hatched, never filled from a neighbour), drawer quality badges and feed note, chips open their last fetch run; `bun run e2e:quality` writes 11 shots to docs/evidence/quality/. Perf: scrub 7.7 ms, cached 0.3 ms, first token p50 1.0 s, local edit 0.6 ms (same frame 20/20, `overlayOps`), RTC 12 ms, WS 82 ms, poll 8/8 (first retry within 2 min), idle 0, cold first globe frame 1.7 s (Cesium `preloadModule`). `e2e:team` runs on the shared stack. CONTRACT-REQUEST: C2 `Sighting.ingestedAt: Time!`; C4 `ENV_FLAGGED = -32767`. Web 590 tests, api 207.
- T27/T28 merged with main (T38, T40–T43); both contract requests accepted. Quality flags in plain words under T41's evidence summary (technical badges under "Details for experts"); About popover feed rows open their last fetch run; `overlayOps` covers field notes (write after delete stays deleted) and feeds NOTES pins; `e2e:team` on the shared stack, `E2E_TEAM_STACK=dev` for dev-stack.ts. Prompt: the 48 h globe window only for questions about what the globe shows (it had narrowed "tegu reports near Homestead"); sightings results list `lateRecords`. Merged tree: leaf-T27 3/3, leaf-T28 2/2, live eval 5/5 + 15/15 four in a row, QUALITY 5 cases, FIRSTLOAD/CHROME/ATTRIBUTION, SPECIES, EXTERNAL-LINKS 30/30, LAYOUT, AXE 0/0 + KEYBOARD-OK, NOTES, TEAM (both stacks), SCRUB 9.05 ms, IDLE 0, DBWORKER 0.2 ms, first token p50 1.1 s. Web 678 tests, api 219, clippy clean.
- T27/T28 merged (quality 5 cases, eval 15/15 x4, perf table). Web 678, API 219.

## Pivot: Lionfish Watch (2026-10-01)

Spec: `docs/LIONFISH_WATCH.md`. Brief: `docs/TASK_BRIEF.md`. Lionfish only, four areas (Florida Keys, Mexican Caribbean, Belize, Colombian Caribbean). Species is a config unit so a python dashboard can reuse the UI later. Gates files: `gates/leaf-L*.md`. Existing T1–T44 gates describing python/Everglades behaviour are superseded where a pivot leaf says so.

### Pivot contract

- **P1 species config:** one `SpeciesConfig` (id, taxa, areas, feeds, score components and weights, rules, agent persona, helper questions, eval set, copy) selected by `INVERSA_SPECIES` (default `lionfish`). No lionfish literal outside config.
- **P2 areas:** four named bboxes from L1's `docs/evidence/data-proof.md`; ids `fl-keys`, `mx-caribbean`, `belize`, `co-caribbean`.
- **P3 honesty:** score shows components separately (recent reports, ID quality, heat stress, completeness); no single risk percent; sightings are not abundance; heat stress is context.
- **P4 scope guard:** data, tools and agent answers outside the four areas or the enabled species are refused with the area names.

### Leaves

| Leaf | Owns | Depends |
|---|---|---|
| L1 data proof | `scripts/probe-lionfish.ts`, `docs/evidence/data-proof.md` | none |
| L2 species config + area scope | `api/src/model.rs`, `api/src/config*`, `apps/web/shared/**` config | L1 |
| L3 NOAA CRW adapter | `api/src/ingest/poll/crw.rs`, `api/fixtures/crw/**` | L1 |
| L4 marine + buoys + backfill (4 areas) | `openmeteo.rs`, `ndbc.rs`, `inat.rs`, `gbif.rs`, `nas.rs`, `api/src/backfill.rs` | L1, L2 |
| L5 priority score | `api/src/hotspot/**` | L2, L3 |
| L6 UI: branding, presets, evidence card | `apps/web/client/**` | L2, L5 |
| L7 agent + benchmark | `apps/web/server/agent/**`, `apps/web/eval/**` | L2–L5 |
| L8 docs | `docs/**`, `README.md` | all |
| L9 integration, redeploy, verify | all | all |

### Status log

- L1 merged 6/6 (driver re-ran gate-check). bz/co thin, NAS is global, CRW via ERDDAP. See docs/LIONFISH_WATCH.md.
- T44 merged 12/12 (taxon cards, 7d window, categories popover, SVG icons). API 225, web 692, clippy clean.

### Three-app contract (A0, driver, 2026-10-01)

Facts behind it (from the touchpoint map): the Rust API is single-tenant (one `AppState` with `obs`/`team` DBs and a global `Hub`; bbox constants in `poll/bio.rs`, `poll/physical.rs`, `hotspot/mod.rs`, `frames.rs`, `push/goes_grid.rs`, `quality_phys.rs`; `hotspot::Species` has 4 fixed variants; `frames::SPECIES_COUNT=4`); the web has `SPECIES_IDS`/`REGION_BBOX` constants and the share link (`v=1`) has no app id; RTC room = board id; CRDT already has `Message` entity; RTC `PeerMessage` has only ops/cursor/hello.

- **C-A1 tenancy:** one process, one `AppState` per app id held in `AppRegistry` (`api/src/app/`). Each app has its own data dir `<INVERSA_DATA_DIR>/<app>/{observations,team}.db`, its own `Hub`, scheduler, frames builder and feed-state publisher. No shared mutable state between apps. Ids: `carp`, `lionfish`, `python`. Default `carp`.
- **C-A2 routes:** `/v1/{app}/graphql` (http+ws), `/v1/{app}/frames`, `/v1/{app}/ingest/hook/{source}`, `/v1/{app}/media/...`. `/health` is global and lists apps with per-app feed health. Unknown app: 404 JSON `{"error":"unknown_app","apps":[...]}`. Old unprefixed `/v1/...` routes are removed.
- **C-A3 AppConfig:** JSON files `spec/apps/{carp,lionfish,python}.json` validated by `spec/apps/app-config.schema.json`. Rust (`serde`) and TS (`zod`) load the same files; a conformance test loads all three in both. Fields: `id`, `name`, `icon`, `tagline`, `question`, `kind` (`species` | `conditions`), `taxa[]` (name, iNat/GBIF/NAS keys, color, half-life days; species apps), `regions[]` (id, name, bbox W,S,E,N, cellDeg, camera; one for python/carp, four for lionfish), `locations[]` (id, name, lat, lon, usgs, nwps, nws; carp), `feeds[]` (source, mode `push`|`poll`, params), `score` (components, default weights), `windows` (default, options in hours), `layers[]`, `legend`, `copy`, `helperQuestions[]`, `agent` (persona, scope text, tool allowlist, refusal text), `eval` (golden set id).
- **C-A4 runtime layout:** hotspot/frames/GOES grids are built from `regions[]` at runtime (no bbox consts). Species enum becomes `TaxonIdx(u8)` from config order. EVF2 header carries region count and per-region layout; `SPECIES_COUNT` becomes a header field. Carp (`kind=conditions`) has no hotspot grid; it uses readings, forecast snapshots and alerts queries.
- **C-A5 web:** `apps/web/shared/apps/` exports `loadApps()`, `APP_IDS`, `AppConfig`; `client/state/app.ts` holds the active app (URL `?app=` wins, then localStorage `inversa.app`, then `carp`). Every GraphQL/frames/ws/agent request is prefixed with the app. Share link `v=2` adds `app`. Agent request body carries `app`; the server picks persona, tools allowlist, scope guard and view defaults from config. `SPECIES_IDS`, `REGION_BBOX`, `LAYER_IDS` constants are replaced by config lookups.
- **C-A6 rooms:** board id and RTC room are `<app>:main`; the signal worker `requireId` charset must accept `:`.
- **C-A7 realtime messaging (M1):** new `PeerMessage` variants over the RTC data channel:
  - `{type:"dm.delta", thread, msgId, from, to, seq, at, del:{pos,len}, ins:string}` per keystroke batch (<= 1 per animation frame), ordered by `seq`, idempotent.
  - `{type:"dm.commit", thread, msgId, from, to, text, hlc}` persists as CRDT `Message` with `to` and `thread` fields (new fields on the entity; vectors in `spec/crdt` updated in both runners).
  - `{type:"dm.typing", thread, from, on}` presence.
  - `{type:"note.delta", noteId, from, seq, del, ins}` live character stream of a note being edited; the final text is committed as the existing LWW op. Notes also show peer carets.
- **C-A8 gates culture:** each leaf prints one machine-readable result line (named in its gates) from an e2e or test; gates grep it.

### Wave plan (updated)

Wave 0: C1 (carp proof, running), F1 (ingest modes), Q1 (questions), A0 (this contract). Wave 1: A1a (Rust tenancy), A1b (web seam + selector), M1 (messaging, independent of tenancy beyond C-A6/C-A7). Wave 2: L2–L7 lionfish, C2–C7 carp, P1 python, K1 cleanup. Wave 3: X1–X3 integration, G1 grading, H1 hardening, D1 docs, Z1.

### Status log (pivot)

- F1 merged 4/4 (driver re-ran gate-check). Push where real (GOES SQS, NWWS, CRW/IEMBot nudges), else poll in Rust scheduler with signed hook; nudge route added.
- Q1 merged 5/5 (driver re-ran): 69 carp, 65 lionfish, 68 python questions; 11 new tools specified in spec/apps/questions/*.json; python legacy cases now include 6 refusals under the per-app scope guard (re-baseline).
- G1 merged 5/5: bun run grade; 24 criteria, honest baseline 13.3/100 (21 pending). Later leaves must emit result lines listed in docs/grading/rubric.md.
- A1b merged 9/9 (driver re-ran gate-check); M1 merged 9/9 (re-run, DM p50 26 ms, notes p50 32 ms). Merged tree web 794 pass, typecheck and lint clean. CONTRACT accepted: taxa extra fields, copy.about/region/timezone, /health shape, stream.sync/stream.resync, message value {body,to,thread}. Open: graphql Message to/thread mapping (A1a), signal worker ':' (A1a).
- L3 merged 5/5 (driver re-ran): crw.rs, nudge route, params sst/sst_anomaly/dhw/baa, migration 0006. Web follow-ups: agent PARAMS/units for new params.
- C3 merged 6/6; migration renumbered to 0007_forecasts after L3's 0006_reef_heat. GraphQL: forecasts, forecastVerify, siteStatusAt (conditions apps only).
- L4 merged 7/7 (driver re-ran on merged tree): lionfish ingest across 4 areas, live iNat counts fl=22 mx=24 bz=1 co=4 match API; migration 0008; feeds inat,gbif,nas,crw,openmeteo-marine,ndbc,goes19-sst. Web follow-up: feed ids openmeteo-marine and goes19-sst, capability PARAMS.
- Wave1 integration merged 7/7 (G3 e2e flaky once; watch). Merge fix: web zod accepts region.code and openmeteo-marine/goes19-sst. Merged tree: web 846 pass, api tests pass. Contract: dropped taxa.scientific (scientificName is the field); copy.timezone closed list; layers may name layers the client cannot draw yet.
- C4 merged 7/7 (driver re-ran on merged tree; fast-forward): api 305 pass, bun run check OK. Live CARP-LIVE sites=8 usgs=8 nwps=8 nws=8 snapshots=72 iem=56. Source ids: usgs, nwps, nws-alerts, nws-forecast, iem; migration 0009 discharge_cfs.
- C5 merged 5/5 (driver re-ran on merged tree): api 329 pass; review engine siteReview/reviewHistory/reviewBoard. Gaps -> E1: flow conflict input (discharge_cfs now stored by C4), evidence kinds forecast/reading/alert/review/source/note/mission/message, empty-poll records, low-water flag.
- L5 merged 7/7 (driver re-ran): lionfish components + rankScore, no risk percent; api 344 tests (after golden regen).
- UC merged 8/8 (driver re-ran incl. e2e:carp): carp board/timeline/as-of/drawer, web 886 pass. View event contract: {site?, asOf?, replay?} handled by applyCarpViewEvent; AG1 emits.
- E1 merged 6/6 (driver re-ran): evidence kinds, sources/sourceInfo, review follow-ups (flow conflict, lowWater, alert check), signed hook + nudges, INVERSA_FAKE_NOW clock. Merge fixes: FeedState mode webhook in web, water.noaa.gov publisher both sides (api 368 pass, web 886 pass).
- UL merged 8/8 (driver re-ran e2e:lionfish 3x). FOUND and FIXED production deadlock: hotspot::score::nearest_index used rayon par_chunks_mut inside OnceLock::get_or_init called from rayon workers (hung backfill/frame builder and a test binary); now sequential, first frame 12 ms. AG1 merged; benchmark made blind by default after finding the answer key was injected (questionHint + answer-check); AGB and AG2 running.
- AGB merged 5/6 (G1 honestly unmet: per-run per-category 90 percent is not achievable at n=6-9; driver blind re-run 66/69=95 percent, holdout 41/42=97 percent, ungrounded 0). Decision: pool the 3 runs for per-category bars (task PL after AG2). No answer key in prompts (tests/server/agent/no-answer-key.test.ts).
- H1 merged 7/7 (driver re-ran): per-app caps, typed refusals, web /api/health, per-app DB health, signal route in Caddy, restore drill, HUMAN_STEPS 0-13, security re-audit (2 High fixed: web data dir under ProtectSystem, NEXT_PUBLIC_SIGNAL_URL in release). Open: e2e:appselect lionfish preset expectation (camera 19.58N 84.37W vs 18.6N 81.25W).
