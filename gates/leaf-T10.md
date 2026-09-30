# Gates: T10 GraphQL resolvers, evidence, media proxy (opus)

Scope:
- Implement every C2 query, mutation and subscription over Db::read. `frames`, `hotspots`, `explainCell` and `backtest` delegate to T11's functions; `applyOps` and `opsSince` delegate to T12's `crdt.rs`.
- `evidence(id)` per C14 returns the normalized record, the raw payload (from Archive, gunzipped), the source URL, fetch time, ingest lag, feed state, and duplicate/conflict/revision links.
- `/v1/media/:id` proxies iNat photos. Only hosts on an allowlist are accepted (SSRF guard). Responses are cached in the Archive and served with `Cross-Origin-Resource-Policy: same-origin`.
- Subscriptions `feeds`, `framesUpdated` and `ops` are backed by the Hub.

- [ ] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G2: a resolver test per query (feeds, sightings, readings, alerts, frames, hotspots, explainCell, backtest, evidence, board, opsSince) against a seeded memory DB; tests are named `resolver_*`
  CHECK: cargo test --manifest-path api/Cargo.toml resolver_ 2>&1 | grep -E "running|test result"
  EXPECT: /running (1[1-9]|[2-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: evidence(id) returns the raw payload and links for a sighting that has a GBIF duplicate and a revision
  CHECK: cargo test --manifest-path api/Cargo.toml evidence 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: media proxy rejects non-allowlisted hosts, private IPs and redirects to them; allowlisted responses carry CORP
  CHECK: cargo test --manifest-path api/Cargo.toml media 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: a graphql-transport-ws subscription test receives an `ops` event after `applyOps`
  CHECK: cargo test --manifest-path api/Cargo.toml subscription_ops 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: the schema contract test still passes
  CHECK: cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending
