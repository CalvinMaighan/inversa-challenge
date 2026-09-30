# Gates: T12 CRDT in Rust + TS (fable)

Scope:
- C5 CRDT with shared golden vectors in `spec/crdt/*.json`.
- Rust `api/src/crdt.rs`: `apply_ops(tx, board, ops) -> ApplyResult` assigns seq, is idempotent on id, materializes fields/messages/removal_counts, and publishes Hub Op events. Also `ops_since` and `board` read helpers.
- TS `apps/web/client/threads/crdt/`: HLC (tick, receive, compare), a pure merge over an in-memory store, and the same materialization.

- [ ] G1: at least 12 vectors exist, covering concurrent LWW, tombstone, message order, counter merge, duplicate delivery, out-of-order delivery, and an HLC tie broken by nodeId
  CHECK: ls spec/crdt/*.json | wc -l | tr -d ' '
  EXPECT: /^(1[2-9]|[2-9][0-9])$/m
  EVIDENCE: pending

- [ ] G2: Rust passes all vectors; the test prints `CRDT vectors passed: N/N`
  CHECK: cargo test --manifest-path api/Cargo.toml crdt -- --nocapture 2>&1 | grep -E "CRDT vectors passed|test result"
  EXPECT: /CRDT vectors passed: (\d+)\/\1[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: TS passes all vectors; the test prints `CRDT vectors passed: N/N`
  CHECK: cd apps/web && bun test tests/client/threads/crdt 2>&1 | grep -E "CRDT vectors passed|fail"
  EXPECT: /CRDT vectors passed: (\d+)\/\1[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G4: shuffled-order property test: 200 random permutations of each vector converge to the same state (both languages)
  CHECK: cargo test --manifest-path api/Cargo.toml crdt_permutations 2>&1 | grep "test result" && cd apps/web && bun test tests/client/threads/crdt 2>&1 | grep -c permutation
  EXPECT: /test result: ok[\s\S]*[1-9]/
  EVIDENCE: pending

- [ ] G5: applyOps is idempotent in SQLite: the same batch twice gives applied=0 and duplicates=N on the second call (test)
  CHECK: cargo test --manifest-path api/Cargo.toml apply_ops_idempotent 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending
