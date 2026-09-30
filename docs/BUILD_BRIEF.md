# Build brief: Everglades Ops (Inversa take-home)

## 0. Execution instruction

- **Target workspace:** `/Users/calvin/Documents/inversa-challenge`
  - Remote: `github.com/CalvinMaighan/inversa-challenge`, private, branch `main`.
- **Source of truth:**
  - `docs/PRD.md` (v3). Read it fully before planning.
  - `docs/research.md` (decisions, push-feed findings, reuse map).
  - This brief summarizes both. When they disagree, the PRD wins, and you log the conflict.
- **Load the `unlazy` skill:**
  - Location: `/Users/calvin/.claude/skills/unlazy/SKILL.md`, which resolves to `/Users/calvin/.agents/skills/unlazy`.
  - Read `references/orchestration.md` and the templates in `templates/` (`PLAN.md`, `gates-leaf.md`, `gates-node.md`).
  - Checker: `node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 <gates-file>`.
  - Always pass `--timeout` explicitly. A v2 argument-parsing bug can otherwise skip the first file.
- **Read the user's global rules:** `/Users/calvin/.claude/CLAUDE.md` and `/Users/calvin/.claude/rules/*.md`.
  - Use lean-ctx `ctx_*` tools when they are available.
  - Use terse output style.
  - Apply the YAGNI and minimal-code ladder.
  - Never skip validation, security, or error handling.
- **Mode: orchestrated.** You are the driver.
  - You plan, write contracts, dispatch leaves as subagents, re-run their gates, merge, and integrate.
  - You don't implement leaves yourself, except wave 0 (contracts and skeleton) and the integration nodes.
- **Subagent models:**
  - Use `model: "fable"` for novel, high-risk leaves: SAB threads, CRDT, GOES decode, hotspots/frames, the client db worker, the rtc/team leaf.
  - Use `model: "opus"` for port-a-known-pattern leaves: Axum skeleton port, pollers, GraphQL resolvers, agent port, voice port, Next shell, deploy/CI, UI leaves, signal Worker.
  - The driver stays on the strongest model. Every verification pass is done by the driver.
  - **Assumption:** this tiering assumes Fable 5.1 is the stronger model for novel design work. If the user says otherwise, swap the tiers.
- **Parallelism:**
  - Run leaves in the same wave concurrently. Use Agent `isolation: "worktree"` so that each leaf works on its own branch.
  - The driver merges the leaf branches into `main` in wave order, after re-running each leaf's gates on the merged tree.
  - Leaves never commit to `main` and never push.
- **Outward-facing actions:** do not deploy, push, publish, send email, create accounts, or enter credentials unless the user explicitly authorizes that action in chat.
  - Human-only steps (section 3.4, H1–H10) are blockers. Surface them. Do not work around them.
  - Never print or commit secret values. Secrets live in Doppler and GitHub Actions secrets.

## 1. Goal

Build and deploy https://inversa.calvinmaighan.dev. It is a full-screen, natural-language, voice-capable command center that answers:

> "Where are invasive species active across South Florida right now, and where should removal crews go next?"

It draws on:
- push feeds: the GOES-19 satellite via NOAA NODD SNS → SQS, and NWS via NWWS-OI XMPP;
- polled feeds: iNaturalist, USGS Water, NDBC, CO-OPS, Open-Meteo, USGS NAS and GBIF.

It provides evidence tracing to raw payloads, 30-day timeline replay, explainable hotspots, and a real-time team Missions panel.

**Deadline:** 72 h wall clock. The PRD is sized as 10 working days for one senior developer; parallel subagents compress that.

## 2. Requirements

### Brief requirements (Inversa)

- **R1:** Three or more real-time feeds around one question (PRD §1–2).
- **R2:** Backend that collects, stores and queries the feeds (PRD §6–7, §9).
- **R3:** Web interface with natural-language queries over real-time and historical data (PRD §10–11).
- **R4:** Interactive timeline that visualizes and replays change, and scrubs smoothly (PRD §12, §13).
- **R5:** Clear treatment of stale, missing, conflicting, duplicate and late data (PRD §7).
- **R6:** A production agent that gives grounded answers with citations to evidence, and evidence traceable to its source (PRD §10).
- **R7:** Deployed at the shared URL `https://inversa.calvinmaighan.dev` (PRD §14).
- **R8:** At least one meaningful new technology: SAB threads, client SQLite + CRDT, WebRTC over Workers/R2 (PRD §12).

### User decisions

- **R9:** Rust Axum multi-threaded data plane: ingest, SQLite (one writer thread plus a read pool), GraphQL, realtime hub, rayon compute.
- **R10:** Push-first ingest.
  - GOES-19 SNS → SQS long-poll.
  - NWWS-OI XMPP when credentials exist, with the NWS API poll as fallback.
  - A generic HMAC webhook endpoint.
  - Pollers under a rate governor for sources that have no push.
- **R11:** Agent on the deedee cordis/dsh harness with `deepseek-v4-flash` via Fireworks, streaming NDJSON.
- **R12:** Voice on grok-voice, using deedee's audio architecture.
  - Direct UI tools.
  - `spawn_thinking` handoff to the agent.
- **R13:** App-first full-screen CesiumJS globe (ion Community) with a tactical HUD.
  - The agent orb sits bottom-right and morphs into a small chat card.
  - There is no side menu.
- **R14:** Fork of `@calvinjs/active-state`.
  - Imported as a git subtree at `packages/active-state`.
  - New `./threads` subpath: SharedArrayBuffer transport, GraphQL on a worker, WebRTC on its own worker, SQLite on a worker.
- **R15:** Client SQLite (sqlite-wasm OPFS) with CRDT, optimistic rendering and caching. Clients post patches to the shared team board.
- **R16:** WebRTC for fast optimistic patches and real-time team messages. Signaling runs on a Cloudflare Worker + R2.
- **R17:** The user's themes via `active-theme`, as a subtree, with the import fix. Modes are light, dark and tactical, with palettes from big-value.
- **R18:** Clean code that follows big-value and deedee conventions. Borrow God's Eye View patterns and the HUD look, but no shaders.
- **R19:** Low runtime budget. Stay on free tiers where possible, and cap LLM and voice spend daily.

## 3. Verified context

### 3.1 Toolchain (checked 2026-09-30)

- **Installed:** cargo 1.96.1, bun 1.3.14, node v22.23.1, doppler.
- **Not installed:** `wrangler` and `aws`. Use `bunx wrangler`. The AWS setup is a human step (H4).

### 3.2 Reuse sources (all paths verified)

**big-value** (`/Users/calvin/Documents/big-value`)

- **API:**
  - `api/Cargo.toml`: axum 0.8, async-graphql 7, rusqlite bundled, tokio, reqwest rustls.
  - `api/src/main.rs`: `AppState`, `app()`, and oneshot tests.
  - `api/src/db.rs`: `Db(Arc<Mutex<Connection>>)`, WAL, `include_str!` migrations tracked in `schema_migration`, `Db::memory()`. **Change needed:** replace the mutex with a writer thread plus a read pool.
  - `api/src/graphql.rs`: graphql-transport-ws at `GET /v1/graphql`.
  - `api/src/realtime.rs`: a `tokio::broadcast` Hub.
- **Deploy:** `deploy/{Caddyfile, bigvalue-*.service, litestream.yml, bootstrap.sh, remote-unpack.sh}`.
- **CI:** `.github/workflows/{check,release,deploy}.yml`.
- **Front end:**
  - `next.config.ts` rewrites `/v1`.
  - `client/state/index.ts`, `client/ui/Providers.tsx`, `client/themes/tokens.ts`.
  - `eslint.config.mjs` plus `eslint.bigvalue.config.mjs`.

**deedee** (`/Users/calvin/Documents/deedee`)

- **Agent harness:** `@deepseek-ai/cordis@4.0.1` and `@deepseek-ai/dsh-*@0.1.1-rc.2`. The exact list is in `package.json` lines 105–135.
  - Files to port:
    - `server/agent-platform/cordis/{boot.ts,cordis.yml,limits.ts,stream-bridge.ts,capability-tools.ts,plugins/llm-openai-compat.ts,plugins/mock-llm.ts}`
    - `server/agent-platform/runtime/{run-deedee-chat.ts,registry.ts,model.ts}`
    - `app/api/deedee-chat/stream/route.ts`
  - Tests to mirror: `tests/server/agent-platform/cordis/*.test.ts`.
- **Chat UI:**
  - `client/ui/chat/ask/useAskNdjsonStream.ts`, `client/ui/chat/assistant/stream-output/*`.
  - `client/features/deedee-chat/{useDeedeeChat.ts,DeedeeChatPanel.tsx}`.
  - `client/state/constants/SHELL_CHAT.ts`.
- **Voice:**
  - Client: `client/voice/{mic-capture,pcm,audio-uplink,playback,barge-in,voice-runtime}.ts`.
  - Shared: `shared/voice/protocol.ts`.
  - Server: `server/voice/{grok-realtime,voice-session,voice-sessions,voice-prompt,announcement-window}.ts`.
  - Routes: `app/api/voice/session/route.ts` and its sub-routes.
  - UI: `client/features/deedee-chat/{VoiceMode.tsx,voice-mode.styled.ts}`.
  - Model: xAI `grok-voice-latest`, env `XAI_API_KEY`, server relay. Audio: 16 kHz PCM16 up, 24 kHz down.
- **Morph:** `client/ui/modal/morph/RectMorphPortal.tsx`, `client/ui/interaction/morph/{useRectMorph.ts,rect-geometry.ts,morph-timing.ts}`.

**Libraries:**
- **active-state:** `/Users/calvin/Documents/client-state`, remote `CalvinMaighan/active-state`, npm `@calvinjs/active-state` 0.1.0.
- **active-theme:** `/Users/calvin/Documents/active-theme`. Its `/state` imports unscoped `active-state`; this needs fixing.

**God's Eye View** (`/Users/calvin/.opensrc/repos/github.com/bilawalsidhu/gods-eye-view/main`, MIT)

| Pattern | Files |
|---|---|
| Feed-state envelope | `src/data/feedState.js`, `src/data/layerSnapshot.js` |
| Analyst tools | `src/data/analystEngine.js`, `src/voice/actionSchemas.js` |
| Rate governor | `server/providers/aircraft/opensky.js` |
| Playback | `src/data/contactPlayback.js` |
| HUD | `src/hud.js`, `src/scopeMask.js`, `src/data/detection.js`, `src/data/labelArbiter.js` |
| Render governor | `src/renderGovernor.js` |
| Share links | `src/sharelink.js` |
| Imagery ladder | `src/maps/imagery.js` |
| Layer contract | `src/layers/earthquakes/index.js` |

### 3.3 External facts (verified 2026-09-30)

- **iNaturalist API v1 is live.** 758 observations of *Python bivittatus* in Florida; the newest is from 2026-09-29.
- **USGS NAS API v2 is live.** 7,026 FL lionfish records.
- **GOES-19 SNS topic:** `arn:aws:sns:us-east-1:123901341784:NewGOES19Object`.
  - Only SQS and Lambda subscribers are allowed.
  - Objects live in bucket `noaa-goes19`.
- **NWWS-OI:** account request by email to `NWWS.Issue@noaa.gov`. It can take 10+ days.
- **Cloudflare Workers free plan:** 5 cron triggers, 10 ms CPU per invocation.
- **COEP `credentialless` is not supported in Safari.** Use `require-corp` plus a same-origin media proxy.
- **Transferable `RTCDataChannel`:** Chrome/Edge 130+ and Safari 15+. Firefox needs a relay.
- **Cesium ion Community:** free for a personal demo. Quotas: 1,000 Google 3D root tiles and 1,000 imagery sessions per month.
- **sqlite-wasm `opfs-sahpool`:** doesn't need COOP/COEP. It allows one connection.

### 3.4 Human-only blockers

| ID | Human action | Blocks |
|---|---|---|
| H1 | Hetzner VM (Ubuntu 24.04, CX22) and SSH access | T33, T34 |
| H2 | DNS for `inversa.calvinmaighan.dev` | T33 |
| H3 | Cloudflare R2 buckets `inversa-raw`, `inversa-litestream`, `inversa-signal` (1-day lifecycle), an R2 token, and a TURN key | T5 live, T20 live, T33 |
| H4 | AWS SQS queue subscribed to NODD with the filter policy from T7, and an IAM user with receive/delete permissions | T7 live |
| H5 | `FIREWORKS_API_KEY` | T13 live |
| H6 | `XAI_API_KEY` | T15 live |
| H7 | `CESIUM_ION_TOKEN` | T17 live |
| H8 | Doppler project `inversa` (`dev`, `prd`) and its GH secret | T33 |
| H9 | The user sends the NWWS-OI request email | T8 live (optional) |
| H10 | Approval of an upstream push of the `threads` branch | T2 upstream push only |

### 3.5 Assumptions

- **A1:** Bun workspaces. The Rust crate sits at `api/`.
- **A2:** Next 16 and React 19.2 with TypeScript strict, matching big-value's versions.
- **A3:** Emotion for styling.
- **A4:** Fable is the stronger tier for novel work.
- **A5:** One domain, apart from the signal Worker. The Worker allows CORS from the app origin and sends CORP `cross-origin`.

### 3.6 Open questions

- **Q1:** The Worker hostname. Default: `workers.dev`.
- **Q2:** Whether to push `threads` upstream. Default: don't push.

## 4. Proposed solution and contracts

### Contracts

The driver writes these into `PLAN.md` in wave 0, before fan-out. Leaves must not change them.

- **C1: repo layout and file ownership.**
  - The layout is PRD §5 "Repo layout".
  - Shared manifests are driver-owned: root `package.json`, lockfiles, `api/Cargo.toml`, the `api/src/main.rs` mod list, `apps/web/package.json`.
  - Leaves may add dependencies on their own worktree branch. The driver resolves lockfile conflicts at merge.
- **C2: GraphQL SDL.**
  - PRD §9, written as `api/schema.graphql`.
  - Scalars: `Time` is RFC 3339; `BBox` is `{west,south,east,north}`.
  - `FrameChunk.data` is base64 of the C4 format.
  - A CI check diffs `schema.sdl()` against the file.
- **C3: feed-state envelope.** `{source, mode: push|poll, state: nominal|lagging|stale|down, newestObservedAt, lastFetchAt, lagSeconds, note}`.
- **C4: binary frame format.**
  - Little-endian. Header: `magic "EVF1"`, `u32 frameCount`, `u32 cellCols`, `u32 cellRows`, `f64 west,south,cellDeg`, `i64 frame0UnixMs`, `u32 stepMinutes`.
  - Per frame, as `Float32Array`s: `hotspot[species][cells]`, `lst[cells]`, `sst[cells]` (NaN = missing).
  - Then a sighting index: `u32 count` followed by `(f32 lon, f32 lat, u16 taxon, u8 quality, u8 flags)`.
  - A golden file lives at `spec/frames/sample.evf`.
- **C5: CRDT op.**
  - Shape: `{id: uuidv7, hlc: "wallMs:counter:nodeId", boardId, entity: mission|note|message|removal, entityId, field, value, nodeId}`.
  - Merge rules:
    - Mission and note fields are last-writer-wins by HLC; a delete is the tombstone field `_deleted`.
    - Messages are append-only, ordered by HLC.
    - Removals are a grow-only counter per node.
  - `apply` is idempotent on `id`.
  - Golden vectors live at `spec/crdt/*.json` as `{ops, expected}`. Rust and TS must both pass them.
- **C6: SAB transport.**
  - One SAB per thread pair.
  - `Int32Array` control block: `[writeCursor, readCursor, keyVersions[256]]`.
  - SPSC byte ring of frames `u16 keyIndex, u32 len, bytes(JSON utf8)`.
  - Writers call `Atomics.notify`. Readers use `Atomics.waitAsync` on main and `Atomics.wait` in workers.
  - The fallback is `postMessage` behind the same `Transport` interface: `send(keyIndex, value)`, `onMessage(cb)`, `close()`.
- **C7: agent NDJSON events.** deedee's `DeedeeChatStreamEvent` plus `{type:"view",bbox,time}` and `{type:"citation",id,kind,label}`. Defined in `apps/web/shared/agent/events.ts`.
- **C8: voice protocol.** deedee `shared/voice/protocol.ts`, plus the UI tools `fly_to`, `set_time`, `play_timeline`, `toggle_layer`, `select`, `open_evidence`. They live in `apps/web/shared/voice/ui-tools.ts`.
- **C9: signaling API.**
  - `POST/GET /rooms/:room/peers`
  - `POST/GET /rooms/:room/inbox/:peer`
  - `GET /turn`
  - CORS is allowed only from the app origin, and responses include CORP `cross-origin`.
- **C10: HMAC hook.**
  - `POST /v1/ingest/hook/:source` with headers `X-Timestamp` and `X-Signature: hex(HMAC_SHA256(secret, ts + "." + body))`.
  - Replay window: 300 s.
- **C11: npm scripts.** `dev`, `build`, `lint`, `typecheck`, `test`, `test:api`, `eval`, `check`.

### Scope

- **Out of scope:** auth, shaders, a validated ecological model, and the IndexedDB fallback (unless OPFS is proven unavailable).
- **Stretch:** the Firecrawl hook, only after the root gates pass.

### Waves (targets for 72 h)

| Wave | Tasks | Target |
|---|---|---|
| W0 | T1 | h0–3 |
| W1 | T2, T3, T4, T5, T6, T7, T20 | h3–14 |
| W2 | T8, T9, T10, T11, T12, T13, T15, T16 | h14–30 |
| W3 | T14, T17, T18, T19, T21 | h30–46 |
| Integration | T22–T32 | h46–62 |
| Ship | T33–T36 | h62–72 |

If a wave slips, cut in this order, recording each cut as `ABANDON`:
1. Firecrawl.
2. NWWS-OI (the poll stays).
3. The Firefox relay.
4. Multi-tab leader election.
5. The rtc worker.
6. Google 3D tiles.
7. Client-side barge-in.

## 5. Task list

Gates files: `gates/leaf-T<n>.md` for leaves, `gates/node-<name>.md` for integration nodes.

### Wave 0

- [ ] **T1: Contracts and skeleton** (driver)
  - Write `PLAN.md`: C1–C11, the tree, the ownership table, a status log.
  - Scaffold Bun workspaces: `apps/web`, `apps/signal-worker`, `packages/*`, `spec/`.
  - Scaffold `api/`: compiles, serves `/health`, has the empty module tree, and declares the known deps.
  - Scaffold `apps/web` as Next 16, strict TS, Emotion.
  - Write `api/schema.graphql`, the event and protocol contracts, the npm scripts, and `check.yml`.
  - Write gates files for every task.
  - **Acceptance:** install, typecheck and cargo build succeed; `/health` returns `ok`.

### Wave 1

- [ ] **T2: active-state and active-theme subtrees** (opus)
  - Subtrees plus the import fix.
  - **Acceptance:** both packages build and their tests pass; there are no unscoped imports.
- [ ] **T3: Next shell, themes and state catalog** (opus)
  - Theme bootstrap, three theme modes, the keys, `Providers`, COOP/COEP, the `/v1` rewrite, self-hosted fonts.
  - **Acceptance:** `crossOriginIsolated === true`; theme modes toggle.
- [ ] **T4: Axum data core** (opus)
  - Writer thread plus read pool, migrations, Hub, feed state, schema stubs.
  - **Acceptance:** a concurrent read/write test passes; the schema diff passes.
- [ ] **T5: R2 archive, scheduler, rate governor, HMAC hook** (opus)
  - **Acceptance:** unit tests for backoff, HMAC and the archive.
  - The live gate is blocked on H3.
- [ ] **T6: Deploy and CI** (opus)
  - Caddyfile, systemd units, Litestream, bootstrap, workflows.
  - **Acceptance:** `caddy validate` and `actionlint` pass.
  - The live gate is blocked on H1, H2, H3 and H8.
- [ ] **T7: GOES-19 SQS consumer and NetCDF bbox window** (fable)
  - Deliverables: the SNS filter policy and the H4 instructions.
  - **Acceptance:** a fixture test extracts values and cloud flags; the projection test is within 0.01°.
- [ ] **T20: Signal Worker** (opus)
  - **Acceptance:** a two-peer exchange works under `wrangler dev`.

### Wave 2

- [ ] **T8: Physical pollers** (opus)
  - NWS, USGS, NDBC, CO-OPS, Open-Meteo, plus NWWS-OI behind an env flag, plus conflict detection.
  - **Acceptance:** fixture tests pass; normalizers are idempotent.
- [ ] **T9: Biological pollers** (opus)
  - iNat, NAS, GBIF, plus dedupe, revisions and the backfill command.
  - **Acceptance:** fixture tests prove the dedupe links and revisions.
- [ ] **T10: GraphQL resolvers** (opus)
  - All resolvers, evidence, the `/v1/media` proxy with CORP, and subscriptions.
  - **Acceptance:** oneshot tests pass; a WebSocket subscription test passes.
- [ ] **T11: Frames and hotspots** (fable)
  - rayon hotspots with explain and backtest; C4 frames with the golden file.
  - **Acceptance:** score tests and the golden round-trip pass; the benchmark number is recorded.
- [ ] **T12: CRDT in Rust and TS** (fable)
  - At least 12 golden vectors.
  - **Acceptance:** both languages pass every vector.
- [ ] **T13: Agent port** (opus)
  - cordis/dsh with the capability tools over GraphQL, citation enforcement, limits, cache, NDJSON, eval.
  - **Acceptance:** mock-LLM tests pass; the eval pass count is measured.
- [ ] **T15: Voice port** (opus)
  - grok relay, deedee audio, UI tools, `spawn_thinking`, caps.
  - **Acceptance:** unit tests pass, including a mocked session emitting `fly_to`.
- [ ] **T16: active-state `./threads`** (fable)
  - SAB ring, fallback transport, bulk views.
  - **Acceptance:** tests cover wraparound, 1 MB values, 10k messages in order, and both transports.

### Wave 3

- [ ] **T14: Agent orb and morph card** (opus)
  - **Acceptance:** Playwright flow: question → citation → drawer.
- [ ] **T17: Globe and layers** (opus)
  - Cesium, the imagery ladder, the layer contract, layers, the render governor.
  - **Acceptance:** renders under COEP; no CORP errors; idle render is paused.
- [ ] **T18: HUD, timeline and evidence drawer** (opus)
  - Feed chips, scrubber, brackets, scope mode, drawer, share links, explain and backtest panels.
  - **Acceptance:** scrubbing makes no network requests; median frame change is under 16 ms.
- [ ] **T19: gql and db workers** (fable)
  - sqlite-wasm OPFS cache, SAB frames, CRDT apply, leader election.
  - **Acceptance:** cached queries under 20 ms; OPFS reload; second-tab proxy.
- [ ] **T21: Team realtime** (fable)
  - rtc worker, mesh, Missions panel, chat.
  - **Acceptance:** two contexts converge; RTC and WS p50 latencies are measured.

### Integration and cross-cutting

- [ ] **T22: node-data.** Axum with fixtures end to end; clippy clean.
- [ ] **T23: node-client.** SAB frames drawn on the globe from local Axum.
- [ ] **T24: node-convo.** Voice or text gives a cited answer; the globe flies to it; the drawer opens.
- [ ] **T25: node-team.** Two contexts converge.
- [ ] **T26: node-root.** `bun run check` passes, and the root gates are met.
- [ ] **T27: Data-quality end to end.** Each case is visible in the UI, the drawer and the agent's wording.
- [ ] **T28: Performance pass.** Every PRD §13 target is measured.
- [ ] **T29: Cold-snap replay fixture.**
- [ ] **T30: Accessibility and 375 px layout.**
- [ ] **T31: Security pass.** HMAC, SSRF allowlist, CORS, no secrets in the bundle, rate limits.
- [ ] **T32: Docs.** README, demo script, interview notes.

### Ship (explicit user authorization per action)

- [ ] **T33: Deploy.** COEP header and `/health` verified on the live URL.
- [ ] **T34: Litestream restore drill.** Counts match before and after.
- [ ] **T35: Live feed verification.** GOES push to a visible frame in under 60 s.
- [ ] **T36: Final review** on Chrome, Safari and Firefox.

## 6. Gates and reporting

### Root gates (`GATES.md`)

- G1: `bun run check`
- G2: `cargo test --manifest-path api/Cargo.toml`
- G3: `bun run eval`
- G4: `gate-check --status gates/*.md` reports `ALL MET`, or `ABANDON` lines with reasons.
- G5 (manual): the live URL checks.
- G6 (manual): a table mapping each requirement R1–R19 to gates.

### Per leaf

- A leaf's brief is the contract section plus its own gates file.
- The leaf works four passes: implement, expert re-read, defect hunt, polish.
- It runs `node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 gates/leaf-T<n>.md`.
- It stops only when every gate is met, or the unmet gates carry `ABANDON` lines.

### Driver

- Re-run every leaf's checks on the merged tree.
- Append one line per event to the `PLAN.md` status log.

### Final report

The report contains:
- the ledger, N of N, re-counted at report time;
- every `ABANDON` line;
- the requirement-to-gate table;
- the measured performance numbers;
- the remaining human blockers;
- the URL, only if deploy succeeded.
