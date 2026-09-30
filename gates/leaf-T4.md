# Gates: T4 Axum data core (opus)

Scope: Db internals = one dedicated writer thread (mpsc commands, batched transactions, oneshot replies) + N-connection read pool via spawn_blocking; C12 signatures unchanged; Hub; feed_state computation; async-graphql schema wired at /v1/graphql (HTTP + graphql-transport-ws) with stub resolvers matching api/schema.graphql.

- [ ] G1: all api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G2: concurrency test exists and passes: 8 writer tasks x 8 reader tasks, no SQLITE_BUSY, all rows present
  CHECK: cargo test --manifest-path api/Cargo.toml db::tests::concurrent 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: writer is a dedicated OS thread, reads use a pool (no single Mutex<Connection> for both)
  CHECK: grep -lE "std::thread::(spawn|Builder)" api/src/db/writer.rs && grep -cE "spawn_blocking" api/src/db/pool.rs api/src/db/mod.rs | grep -v ":0" | wc -l | tr -d ' '
  EXPECT: /writer\.rs\s+[1-9]/
  EVIDENCE: pending

- [ ] G4: schema SDL matches api/schema.graphql (test normalizes whitespace/order)
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: POST /v1/graphql answers `{ feeds { source } }` with 200 and a data key (oneshot test)
  CHECK: cargo test --manifest-path api/Cargo.toml graphql_http_smoke 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: feed_state computes nominal/lagging/stale/down from sources + fetch_runs (unit test with 4 cases)
  CHECK: cargo test --manifest-path api/Cargo.toml feed_state 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G7: clippy clean for owned files
  CHECK: cargo clippy --manifest-path api/Cargo.toml --all-targets 2>&1 | grep -E "^(warning|error).*" -A3 | grep -E "src/(db|realtime|feed_state|graphql)" | wc -l | tr -d ' '
  EXPECT: /^0$/
  EVIDENCE: pending
