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

Secrets (never committed): `FIREWORKS_API_KEY`, `XAI_API_KEY`, `CESIUM_ION_TOKEN` (exposed to the client as `NEXT_PUBLIC_CESIUM_ION_TOKEN`), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_RAW`, `GOES_SQS_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NWWS_USER`, `NWWS_PASS`, `INGEST_HOOK_SECRET`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_TOKEN`.

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
- **Frame grid:** a `FrameGrid` from `@calvinjs/active-state/threads` (EVF2 shape). Layers read `hotspot(i, s)`, `lst(i)` and `sst(i)`. The frame index is derived from TIME.

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
