# Gates: T9 biological pollers + dedupe + backfill (opus)

Scope:
- iNat poller: `updated_since` cursor, 1 req/s, focus taxa plus `introduced=true` inside the bbox. ID changes write sighting_revisions.
- USGS NAS and GBIF pollers.
- `quality_bio::post_write` sets canonical_id links:
  - GBIF records whose catalogNumber equals an iNat id;
  - NAS records within 50 m / 24 h of the same taxon.
- `backfill` subcommand: `--days 30`, a 5-year NAS/GBIF baseline, and `--dry-run --fixtures` against fixtures.
- Source registry in poll/bio.rs.

- [x] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 123 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 2.07s

- [x] G2: fixture dirs for inat, nas and gbif hold real recorded payloads
  CHECK: ls -d api/fixtures/inat api/fixtures/nas api/fixtures/gbif 2>/dev/null | wc -l | tr -d ' '
  EXPECT: /^3$/m
  EVIDENCE: 3

- [x] G3: dedupe tests: the GBIF->iNat link and the NAS spatial-temporal link set canonical_id, and unrelated records are untouched
  CHECK: cargo test --manifest-path api/Cargo.toml quality_bio 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 4 tests | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 120 filtered out; finished in 0.16s

- [x] G4: an iNat ID flip produces a sighting_revisions row and a conflict flag (test)
  CHECK: cargo test --manifest-path api/Cargo.toml revision 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 3 tests | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 121 filtered out; finished in 0.13s

- [x] G5: a backfill dry run over fixtures prints measured row counts per source, ending with a line "BACKFILL-DRY-RUN-OK"
  CHECK: INVERSA_DATA_DIR=$(mktemp -d) INVERSA_SOURCES=off cargo run -q --manifest-path api/Cargo.toml -- backfill --dry-run --fixtures 2>&1 | tail -4
  EXPECT: /inat[^\n]*\d[\s\S]*BACKFILL-DRY-RUN-OK/
  EVIDENCE: gbif: payloads=1 rows_in=20 written=20 skipped=0 errors=0 sightings=20 revisions=0 conflicts=0 linked=2 | BACKFILL-DRY-RUN-OK

- [x] G6: rate etiquette: the iNat minimum interval is >= 1 s, asserted by a test
  CHECK: cargo test --manifest-path api/Cargo.toml inat_min_interval 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 123 filtered out; finished in 1.00s
