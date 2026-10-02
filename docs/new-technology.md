# Technology new to me

The brief asks that at least one meaningful part of the solution use a technology that is new to the author. This page says which parts that is, where the code is, what each does in the product, why it is there rather than as decoration, and what I learned. The claim is the one made in `docs/PRD.md` §12 ("New tech 1 to 3") and `docs/BUILD_BRIEF.md` R8; the rubric keeps a manual item for me to confirm it is true (`new-technology/claim-true`).

## Claimed as new to me

### 1. SharedArrayBuffer worker threads (`packages/active-state/src/threads/`)

**What it does.** The browser runs three threads besides the main one: a gql worker (GraphQL over HTTP and WebSocket), a db worker (client SQLite, the CRDT, the frame cache) and an rtc worker (WebRTC data channels). They share state through a SharedArrayBuffer per thread pair: an `Int32Array` control block and a single-producer, single-consumer byte ring, woken with `Atomics.notify` and `Atomics.waitAsync`. I added this as a `./threads` entry to my own state library, `active-state`; the `key / get / set / subscribe` API is unchanged from any thread.

**Why it is not decoration.** It is how the timeline scrubs without the network. Frames arrive as EVF2 binary, the db worker writes them into SharedArrayBuffer views, and the globe reads those views with no copy: python scrub median 7.51 ms over 96 frames with 0 requests (`gates/leaf-H1.md` G6). The T16 gate pushes 10,000 messages through a real worker ring in order (`gates/leaf-T16.md`).

**What I learned.** SharedArrayBuffer needs cross-origin isolation, and that shapes the whole app: COOP `same-origin` and COEP `require-corp` on every response (`deploy/Caddyfile`, `apps/web/next.config.ts`), so third-party photos go through a same-origin proxy (`api/src/media.rs`) and there are no iframes. Safari has no COEP `credentialless`, which is why `require-corp` was chosen. A `postMessage` fallback with the same API covers browsers where `crossOriginIsolated` is false.

### 2. Client SQLite on OPFS with an op-based CRDT (`apps/web/client/threads/db/`, `apps/web/client/threads/crdt/`, `api/src/crdt.rs`)

**What it does.** `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS runs in the db worker as a query cache and as the local copy of team data: notes, missions, chat, direct messages and removal counts. Each edit is a CRDT op with a hybrid logical clock; it applies locally in the same frame, goes to peers, and is persisted by Axum through `applyOps`. The same merge rules exist in Rust and TypeScript and pass the same 19 vectors in `spec/crdt/` (re-measured: `CRDT vectors passed: 19/19`).

**Why it is not decoration.** It is the team board's write path and offline behaviour. Local edits appear in the same animation frame, 20 of 20 (`gates/leaf-T28.md`); a peer that was offline converges on reconnect (`gates/leaf-K1.md` G7, `OFFLINE-OK`); a repeated query is answered from the cache in 0.2 ms (`gates/leaf-T28.md`).

**What I learned.** OPFS sync access handles belong to one tab, so a Web Locks leader owns the database and other tabs proxy through `BroadcastChannel`. Last-writer-wins per field silently drops one of two concurrent edits; that is fine for a mission's status and wrong for prose, which is why free text lives in append-only messages. Writing the merge twice only works with shared test vectors, plus a test that applies each vector's ops in 200 shuffled orders in both languages and requires the same result (`gates/leaf-T12.md` G4).

### 3. WebRTC data channels with a signalling Worker on R2 (`apps/web/client/threads/rtc/`, `apps/signal-worker/`)

**What it does.** Teammates on the same app's board connect peer to peer in a mesh of up to 8 (`MAX_PEERS` in `apps/web/client/threads/rtc/mesh.ts`). A Cloudflare Worker relays only the handshake (offers, answers, ICE) through R2 objects with compare-and-swap on the peer list, and mints short-lived TURN credentials. Over the channel go CRDT ops, cursors, per-keystroke direct-message deltas and live note edits.

**Why it is not decoration.** It carries the real-time messaging the build was asked for: direct messages stream per keystroke at p50 26 ms and live note edits at p50 32 ms between two browsers (`gates/leaf-M1.md` G4, G6); edits reach a peer at p50 12 ms against 84 ms over the WebSocket fallback (`gates/leaf-T28.md`). The server never sees the handshake contents beyond routing.

**What I learned.** Chrome tells the other side nothing when a tab vanishes and ICE takes about a minute to fail, so presence needed its own heartbeat (`hello` every 5 s, away after 20 s; `gates/leaf-M1.md` G5). R2 compare-and-swap works for a small room but contends: a losing write retries with jitter up to 12 times and then answers 503. Durable Objects are the upgrade path.

## New in this build, not part of the claim

These were first used in this codebase. Whether each was new to me is not part of the graded claim, so I do not assert it here (**unverified** as "new to me"):

- GOES-19 ABI L2 NetCDF/HDF5 decode in Rust (`api/src/ingest/push/goes_grid.rs`), on a 0.05° grid sized to a row budget: 7,232 rows per scan, 173,568 a day (re-measured).
- ERDDAP griddap for NOAA Coral Reef Watch (`api/src/ingest/poll/crw.rs`), with a subscription URL used as a nudge.
- The EVF2 binary frame format with readers in both languages and a golden file (`apps/web/shared/frames.ts`, `spec/frames/`).
- A bitemporal forecast store for carp, as-of queries over issued and ingested time (`api/src/forecast/`, `gates/leaf-C3.md`).

## Not new, and not used

- Not new to me: Rust with Axum, async-graphql and rusqlite (the conventions come from my earlier project, big-value), Next.js, and the cordis agent harness (reused from deedee).
- Not used: PostGIS. The queries are bbox and time ranges over one writer per app, which SQLite with B-tree indexes serves on one small VM; adding Postgres would double what has to be run and backed up (`docs/design-alternatives.md` §2).
