# Gates: T5 archive, scheduler, governor, HMAC hook (opus)

Scope: DirArchive + R2Archive (S3 API, SigV4) behind `ingest::archive::from_config`; supervised per-source tokio tasks; rate governor (min interval, x2 on 429/5xx to a cap, Retry-After); ingest pipeline: archive(gzip) -> normalize -> Db::write (upsert rows + fetch_run + quality_*::post_write) -> ack -> cursor -> Hub RowsWritten; C10 hook route; sources table upserted at boot.

- [ ] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G2: governor tests: backoff doubles on 429 and 5xx, caps, honors Retry-After, resets on success
  CHECK: cargo test --manifest-path api/Cargo.toml governor 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: hook tests: valid 202, bad signature 401, timestamp older than 300s 401, missing secret config 503
  CHECK: cargo test --manifest-path api/Cargo.toml hook 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: pipeline test with a fake Source: rows written, fetch_run recorded, raw object archived gzip under raw/{source}/{yyyy}/{mm}/{dd}/, ack called only after commit, re-run of same payload adds 0 rows
  CHECK: cargo test --manifest-path api/Cargo.toml pipeline 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: archive round-trip for DirArchive; R2Archive request signing unit-tested against a known SigV4 vector
  CHECK: cargo test --manifest-path api/Cargo.toml archive 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: a panicking/erroring source is restarted with backoff and does not stop other sources (test)
  CHECK: cargo test --manifest-path api/Cargo.toml supervis 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G7 (live, blocked on H3): one real object written to R2 bucket inversa-raw (quote key)
  EVIDENCE: pending
