# Gates: T4 Axum data core (opus)

Scope: Db internals = one dedicated writer thread (mpsc commands, batched transactions, oneshot replies) + N-connection read pool via spawn_blocking; C12 signatures unchanged; Hub; feed_state computation; async-graphql schema wired at /v1/graphql (HTTP + graphql-transport-ws) with stub resolvers matching api/schema.graphql.

- [x] G1: all api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 27 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.14s

- [x] G2: concurrency test exists and passes: 8 writer tasks x 8 reader tasks, no SQLITE_BUSY, all rows present
  CHECK: cargo test --manifest-path api/Cargo.toml db::tests::concurrent 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.07s

- [x] G3: writer is a dedicated OS thread, reads use a pool (no single Mutex<Connection> for both)
  CHECK: grep -lE "std::thread::(spawn|Builder)" api/src/db/writer.rs && grep -cE "spawn_blocking" api/src/db/pool.rs api/src/db/mod.rs | grep -v ":0" | wc -l | tr -d ' '
  EXPECT: /writer\.rs\s+[1-9]/
  EVIDENCE: api/src/db/writer.rs | 1

- [x] G4: schema SDL matches api/schema.graphql (test normalizes whitespace/order)
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.01s

- [x] G5: POST /v1/graphql answers `{ feeds { source } }` with 200 and a data key (oneshot test)
  CHECK: cargo test --manifest-path api/Cargo.toml graphql_http_smoke 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.01s

- [x] G6: feed_state computes nominal/lagging/stale/down from sources + fetch_runs (unit test with 4 cases)
  CHECK: cargo test --manifest-path api/Cargo.toml feed_state 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 9 tests | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 0.08s

- [x] G7: clippy clean for owned files
  CHECK: cargo clippy --manifest-path api/Cargo.toml --all-targets 2>&1 | grep -E "^(warning|error).*" -A3 | grep -E "src/(db|realtime|feed_state|graphql)" | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G8: writer batches queued commands; a failing or panicking closure rolls back only itself and the writer thread survives
  CHECK: cargo test --manifest-path api/Cargo.toml failing_write_rolls_back_only_itself 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.10s

- [x] G9: graphql-transport-ws end to end over a real socket delivers a Hub event; ops subscription replays backlog without gaps or repeats
  CHECK: cargo test --manifest-path api/Cargo.toml subscription 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [3-9][\s\S]*test result: ok/
  EVIDENCE: running 3 tests | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out; finished in 0.04s
