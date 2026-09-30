# Gates: T7 GOES-19 push consumer (fable)

Scope:
- An SQS long-poll consumer: SigV4 over HTTPS with a 20 s wait, reading NODD NewGOES19Object events filtered to ABI-L2-LSTC, ABI-L2-SSTF, ABI-L2-FDCC and ABI-L2-ACMC.
- It fetches each object from https://noaa-goes19.s3.amazonaws.com/<key>, reads the bbox window from the NetCDF4/HDF5 file, applies the GOES fixed-grid projection, and aggregates to the 0.05 deg GOES grid (driver decision, `g5:<col>:<row>` cells over the PLAN C15 bbox) as goes_cell stations.
- Cloud and bad-DQF pixels inside a product's domain (land for LST, water for SST) are stored as flagged null values; pixels outside the domain produce no row.
- The SQS message is deleted only after commit (Source::ack).
- Deliverables in deploy/aws: the filter policy and the H4 instructions.

- [x] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 78 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.90s

- [x] G2: the projection test maps known GOES-East fixed-grid (x,y) scan angles to lat/lon within 0.01 deg, using reference values from the GOES-R PUG
  CHECK: cargo test --manifest-path api/Cargo.toml goes_grid 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 5 tests | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 73 filtered out; finished in 0.02s

- [x] G3: a fixture test on a real LSTC file in api/fixtures/goes/ extracts >0 non-null cells inside the bbox, and on a real ACMC file extracts >0 cloud-flagged cells
  CHECK: ls api/fixtures/goes/ | grep -ciE "LSTC|ACMC" && cargo test --manifest-path api/Cargo.toml goes_fixture 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /[2-9][\s\S]*running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 6 tests | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 72 filtered out; finished in 0.09s

- [x] G4: SQS message parsing handles SNS-wrapped S3 events and ignores non-matching products (unit test with recorded event JSON)
  CHECK: cargo test --manifest-path api/Cargo.toml goes_sqs 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 10 tests | test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 68 filtered out; finished in 0.10s

- [x] G5: the filter policy exists and admits only the four products
  CHECK: grep -oE "ABI-L2-(LSTC|SSTF|FDCC|ACMC)" deploy/aws/goes-filter-policy.json | sort -u | wc -l | tr -d ' '
  EXPECT: /^4$/m
  EVIDENCE: 4

- [x] G6: the NetCDF/HDF5 build decision (crate + system lib) is recorded in deploy/aws/README.md, and it builds on macOS dev
  CHECK: grep -ciE "netcdf|hdf5" deploy/aws/README.md
  EXPECT: /[1-9]/
  EVIDENCE: 11

- [ ] G7: (live, blocked on H4) one SQS message processed end to end (quote the log line with key and rows_in)
  EVIDENCE: pending

- [x] G8: GOES row volume from the fixtures stays under 250k rows/day (the test prints `GOES rows/scan N`; every consumed product is hourly, so N x 24 < 250000 is asserted)
  CHECK: cargo test --manifest-path api/Cargo.toml goes_fixture_rows_per_scan -- --nocapture 2>&1 | grep -E "^GOES rows/scan [0-9]+ |test result"
  EXPECT: /GOES rows\/scan [1-9]\d* \(rows\/day (\d{1,5}|1\d{5}|2[0-4]\d{4})\)[\s\S]*test result: ok/
  EVIDENCE: GOES rows/scan 5713 (rows/day 137112) | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 77 filtered out; finished in 0.06s

- [x] G9: readings upsert precedence (null never overwrites a value; cloud > bad_dqf > missing between nulls; newer value wins) is covered by readings_upsert_precedence
  CHECK: cargo test --manifest-path api/Cargo.toml readings_upsert_precedence 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running 1 test[\s\S]*test result: ok\. 1 passed/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 77 filtered out; finished in 0.01s

ABANDON: G7 blocked on H4 (AWS SQS not provisioned)
