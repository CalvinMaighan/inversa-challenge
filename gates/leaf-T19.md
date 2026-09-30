# Gates: T19 gql + db workers (fable)

Scope: `apps/web/client/threads/{boot.ts,gql.worker.ts,db.worker.ts,db/**,gql/**}`:
- The gql worker handles GraphQL HTTP and graphql-transport-ws (direct to Axum in dev).
- The db worker runs @sqlite.org/sqlite-wasm on the opfs-sahpool VFS, with tables cache_frames, cache_queries, ops, missions, notes, messages, removal_counts and outbox.
  - Reads are stale-while-revalidate.
  - EVF1 frames are written into SAB Float32Array views (T16).
  - CRDT ops are applied via T12's TS module.
- A Web Locks leader tab owns the db worker; other tabs proxy over BroadcastChannel.
- boot.ts chooses the SAB or postMessage transport from crossOriginIsolated.

- [ ] G1: worker logic tests pass (cache TTL, SWR, outbox ack, EVF to SAB view mapping, transport selection)
  CHECK: cd apps/web && bun test tests/client/threads 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: pending

- [ ] G2: a browser test: a cached query answers in under 20 ms, reload serves from OPFS, and a second tab proxies through the leader; a Playwright script prints `DBWORKER cached=<ms> opfs=1 proxy=1`
  CHECK: cd apps/web && bun run e2e:dbworker 2>&1 | grep DBWORKER
  EXPECT: /DBWORKER cached=(1[0-9]|[0-9])(\.\d+)? opfs=1 proxy=1/
  EVIDENCE: pending

- [ ] G3: the fallback transport works with isolation disabled (a test flag); the script prints `FALLBACK-OK`
  CHECK: cd apps/web && bun run e2e:dbworker -- --no-isolation 2>&1 | tail -1
  EXPECT: FALLBACK-OK
  EVIDENCE: pending

- [ ] G4: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: pending
