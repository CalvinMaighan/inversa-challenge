# Gates: T8 physical pollers + NWWS-OI (opus)

Scope:
- Pollers:
  - NWS alerts (If-Modified-Since, 60 s, User-Agent)
  - USGS IV Everglades gages (15 min)
  - NDBC realtime2 buoys
  - CO-OPS water level
  - Open-Meteo forecast + marine, 48 h
- NWWS-OI XMPP push (tokio-xmpp), filtered to MFL/KEY. Enabled only when NWWS_USER is set.
- `quality_phys::post_write` flags as conflicts: satellite vs buoy SST differing by more than 1.5 C, and LST vs air temperature outside the expected offset.
- Source registry in poll/physical.rs.

- [x] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 200 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 2.70s

- [x] G2: each adapter has a fixture test on a real recorded payload (5 fixture dirs)
  CHECK: ls -d api/fixtures/nws api/fixtures/usgs api/fixtures/ndbc api/fixtures/coops api/fixtures/openmeteo 2>/dev/null | wc -l | tr -d ' '
  EXPECT: /^5$/m
  EVIDENCE: 5

- [x] G3: normalizers are idempotent: normalizing and writing the same payload twice adds 0 rows (one test per adapter, so >= 5 tests match "idempotent")
  CHECK: cargo test --manifest-path api/Cargo.toml idempotent 2>&1 | grep -E "test result|running"
  EXPECT: /running ([5-9]|[1-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: running 9 tests | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 193 filtered out; finished in 0.19s

- [x] G4: conflict detection tests (SST satellite vs buoy, LST vs air) pass
  CHECK: cargo test --manifest-path api/Cargo.toml quality_phys 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 4 tests | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 198 filtered out; finished in 0.02s

- [x] G5: the NWWS source is absent without NWWS_USER, and parses a recorded product stanza when present (test)
  CHECK: cargo test --manifest-path api/Cargo.toml nwws 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 9 tests | test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 193 filtered out; finished in 0.01s
