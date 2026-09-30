# Gates: T7 GOES-19 push consumer (fable)

Scope:
- An SQS long-poll consumer: SigV4 over HTTPS with a 20 s wait, reading NODD NewGOES19Object events filtered to ABI-L2-LSTC, ABI-L2-SSTF, ABI-L2-FDCC and ABI-L2-ACMC.
- It fetches each object from https://noaa-goes19.s3.amazonaws.com/<key>, reads the bbox window from the NetCDF4/HDF5 file, applies the GOES fixed-grid projection, and aggregates to the 0.01 deg grid (PLAN C15) as goes_cell stations.
- Cloud and bad-DQF pixels are stored as flagged null values.
- The SQS message is deleted only after commit (Source::ack).
- Deliverables in deploy/aws: the filter policy and the H4 instructions.

- [ ] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G2: the projection test maps known GOES-East fixed-grid (x,y) scan angles to lat/lon within 0.01 deg, using reference values from the GOES-R PUG
  CHECK: cargo test --manifest-path api/Cargo.toml goes_grid 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: a fixture test on a real LSTC file in api/fixtures/goes/ extracts >0 non-null cells inside the bbox, and on a real ACMC file extracts >0 cloud-flagged cells
  CHECK: ls api/fixtures/goes/ | grep -ciE "LSTC|ACMC" && cargo test --manifest-path api/Cargo.toml goes_fixture 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /[2-9][\s\S]*running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: SQS message parsing handles SNS-wrapped S3 events and ignores non-matching products (unit test with recorded event JSON)
  CHECK: cargo test --manifest-path api/Cargo.toml goes_sqs 2>&1 | grep -E "test result|running [1-9]"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: the filter policy exists and admits only the four products
  CHECK: grep -oE "ABI-L2-(LSTC|SSTF|FDCC|ACMC)" deploy/aws/goes-filter-policy.json | sort -u | wc -l | tr -d ' '
  EXPECT: /^4$/m
  EVIDENCE: pending

- [ ] G6: the NetCDF/HDF5 build decision (crate + system lib) is recorded in deploy/aws/README.md, and it builds on macOS dev
  CHECK: grep -ciE "netcdf|hdf5" deploy/aws/README.md
  EXPECT: /[1-9]/
  EVIDENCE: pending

- [ ] G7: (live, blocked on H4) one SQS message processed end to end (quote the log line with key and rows_in)
  EVIDENCE: pending
