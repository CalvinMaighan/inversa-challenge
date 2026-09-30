# Gates: T10 GraphQL resolvers, evidence, media proxy (opus)

Scope:
- Implement every C2 query, mutation and subscription over Db::read. `frames`, `hotspots`, `explainCell` and `backtest` delegate to T11's functions; `applyOps` and `opsSince` delegate to T12's `crdt.rs`.
- `evidence(id)` per C14 returns the normalized record, the raw payload (from Archive, gunzipped), the source URL, fetch time, ingest lag, feed state, and duplicate/conflict/revision links.
- `/v1/media/:id` proxies iNat photos. Only hosts on an allowlist are accepted (SSRF guard). Responses are cached in the Archive and served with `Cross-Origin-Resource-Policy: same-origin`.
- Subscriptions `feeds`, `framesUpdated` and `ops` are backed by the Hub.

- [x] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 129 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.13s

- [x] G2: a resolver test per query (feeds, sightings, readings, alerts, frames, hotspots, explainCell, backtest, evidence, board, opsSince) against a seeded memory DB; tests are named `resolver_*`
  CHECK: cargo test --manifest-path api/Cargo.toml resolver_ 2>&1 | grep -E "running|test result"
  EXPECT: /running (1[1-9]|[2-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: running 14 tests | test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 116 filtered out; finished in 0.47s

- [x] G3: evidence(id) returns the raw payload and links for a sighting that has a GBIF duplicate and a revision
  CHECK: cargo test --manifest-path api/Cargo.toml evidence 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 8 tests | test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 122 filtered out; finished in 0.04s

- [x] G4: media proxy rejects non-allowlisted hosts, private IPs and redirects to them; allowlisted responses carry CORP
  CHECK: cargo test --manifest-path api/Cargo.toml media 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 7 tests | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 123 filtered out; finished in 0.07s

- [x] G5: a graphql-transport-ws subscription test receives an `ops` event after `applyOps`
  CHECK: cargo test --manifest-path api/Cargo.toml subscription_ops 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 129 filtered out; finished in 0.01s

- [x] G6: the schema contract test still passes
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 129 filtered out; finished in 0.00s

Driver additions (T13 request): C14 evidence kind `backtest:<species>:<days>`, and `FeedState.lastFetchRunId` (schema, Rust, TS mirror).

- [x] G7: evidence(`backtest:<species>:<days>`) returns the backtest summary with perDay as the record
  CHECK: cargo test --manifest-path api/Cargo.toml evidence_backtest 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 129 filtered out; finished in 0.01s

- [x] G8: FeedState carries lastFetchRunId (latest fetch_runs id) and evidence can cite it; Rust tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml last_fetch_run 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 129 filtered out; finished in 0.00s

- [x] G9: the TS mirror has lastFetchRunId and the TS contract tests pass
  CHECK: grep -c "lastFetchRunId: string | null" apps/web/shared/feed-state.ts && cd apps/web && bun test tests/shared 2>&1 | grep -E "pass|fail"
  EXPECT: /^1\n[\s\S]*\d+ pass\s+0 fail/
  EVIDENCE: 5 pass | 0 fail
