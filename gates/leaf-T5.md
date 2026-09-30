# Gates: T5 archive, scheduler, governor, HMAC hook (opus)

Scope: DirArchive + R2Archive (S3 API, SigV4) behind `ingest::archive::from_config`; supervised per-source tokio tasks; rate governor (min interval, x2 on 429/5xx to a cap, Retry-After); ingest pipeline: archive(gzip) -> normalize -> Db::write (upsert rows + fetch_run + quality_*::post_write) -> ack -> cursor -> Hub RowsWritten; C10 hook route; sources table upserted at boot.

- [x] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 31 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.04s

- [x] G2: governor tests: backoff doubles on 429 and 5xx, caps, honors Retry-After, resets on success
  CHECK: cargo test --manifest-path api/Cargo.toml governor 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 9 tests | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 22 filtered out; finished in 0.30s

- [x] G3: hook tests: valid 202, bad signature 401, timestamp older than 300s 401, missing secret config 503
  CHECK: cargo test --manifest-path api/Cargo.toml hook 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 7 tests | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out; finished in 0.09s

- [x] G4: pipeline test with a fake Source: rows written, fetch_run recorded, raw object archived gzip under raw/{source}/{yyyy}/{mm}/{dd}/, ack called only after commit, re-run of same payload adds 0 rows
  CHECK: cargo test --manifest-path api/Cargo.toml pipeline 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 5 tests | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 26 filtered out; finished in 0.02s

- [x] G5: archive round-trip for DirArchive; R2Archive request signing unit-tested against a known SigV4 vector
  CHECK: cargo test --manifest-path api/Cargo.toml archive 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 7 tests | test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 24 filtered out; finished in 0.01s

- [x] G6: a panicking/erroring source is restarted with backoff and does not stop other sources (test)
  CHECK: cargo test --manifest-path api/Cargo.toml supervis 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 3 tests | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 1.01s

- [ ] G7: (live, blocked on H3) one real object written to R2 bucket inversa-raw (quote key)
  EVIDENCE: pending

ABANDON: G7 blocked on H3 (R2 bucket/token not provisioned yet)
