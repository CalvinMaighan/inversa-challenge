# Gates: T11 frames + hotspots (fable)

Scope:
- `hotspot/{rules,score,backtest}.rs` implement PRD §8: `score = density × activity × access` per 0.01° cell (C15) and frame.
  - Density uses a per-species half-life kernel; NAS/GBIF history counts at 0.2 weight.
  - Rules carry a rationale string each.
  - rayon parallelism across cells.
- `explain(cell, species, at)` returns each term's contribution.
- `backtest(species, days)` reports the top-10% hit rate against the 10% baseline.
- `frames.rs`:
  - builds EVF2 (C4) frames: u8 hotspot grid at 0.02°, i16 centi-°C environment grid at 0.05°, sighting records;
  - `spawn_builder` subscribes to Hub RowsWritten, debounces 5 s, rebuilds the affected hourly frames into the `frames` table (zlib bodies), and publishes FramesUpdated;
  - exposes `pub async fn chunk(db, from_ms, to_ms, step_min) -> Vec<u8>` (step 60, or 15 for windows ≤ 24 h; at most 744 frames);
  - serves `GET /v1/frames?from=&to=&step=` as `application/x-evf`, gzip content-encoded (`frames::routes()`).
- `spec/frames/sample.evf` is the golden file.

- [x] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: test result: ok. 200 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 2.29s

- [x] G2: score unit tests against hand-computed cells for all 4 species, including a cold-stun iguana case and a lionfish no-access (waves) case
  CHECK: cargo test --manifest-path api/Cargo.toml hotspot 2>&1 | grep -E "running|test result"
  EXPECT: /running ([4-9]|[1-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: running 17 tests | test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 185 filtered out; finished in 0.14s

- [x] G3: EVF2 golden round-trip; the Rust writer output byte-equals spec/frames/sample.evf for the fixed seed input, and the test decodes hand-computed hotspot, environment and sighting values from it
  CHECK: cargo test --manifest-path api/Cargo.toml evf_golden 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 201 filtered out; finished in 0.00s

- [x] G4: the TS reader (apps/web/shared/frames.ts readEvfHeader, evfFrameLayout, readSightingRecords) parses the EVF2 golden file's header and decodes frame 0's sighting record with its id (iguana, sightings.id 3)
  CHECK: bun -e 'import {readEvfHeader, evfFrameLayout, readSightingRecords, EVF_HEADER_BYTES} from "./apps/web/shared/frames.ts"; const v=new DataView(await Bun.file("spec/frames/sample.evf").arrayBuffer()); const h=readEvfHeader(v); const off=EVF_HEADER_BYTES+evfFrameLayout(h).sightingsOffset; const n=v.getUint32(off,true); console.log(JSON.stringify({...h, sightingCount:n, first:readSightingRecords(v,off+4,n)[0]}))'
  EXPECT: /"hsCols":10[\s\S]*"stepMinutes":60[\s\S]*"speciesCount":4[\s\S]*"envCols":4[\s\S]*"envCellDeg":0\.05[\s\S]*"hotspotScale":0\.0(1|0999)[\s\S]*"sightingCount":1,"first":\{"id":3,"lon":-80\.4[0-9]*,"lat":25\.2[0-9]*,"taxon":3,"quality":0,"flags":0\}/
  EVIDENCE: {"frameCount":3,"hsCols":10,"hsRows":5,"west":-80.5,"south":25.2,"hsCellDeg":0.02,"frame0UnixMs":1738368000000,"stepMinutes":60,"speciesCount":4,"envCols":4,"envRows":2,"envCellDeg":0.05,"hotspotScale

- [x] G5: backtest returns hitRate and baseline=0.1 on a seeded dataset (test)
  CHECK: cargo test --manifest-path api/Cargo.toml backtest 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 5 tests | test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 197 filtered out; finished in 0.12s

- [x] G6: a release-mode benchmark for 30 days × 24 hourly frames on the full 340×320 scoring grid prints its duration, the raw bytes per EVF2 frame and the gzip size of the month
  CHECK: cargo test --release --manifest-path api/Cargo.toml bench_frames -- --ignored --nocapture 2>&1 | grep -E "BENCH frames"
  EXPECT: /BENCH frames 720 in [0-9.]+ ?(ms|s) \(\d+ bytes\/frame raw, \d+ KB gzip/
  EVIDENCE: BENCH frames 720 in 3.04s (126278 bytes/frame raw, 31000 KB gzip for 30 days, 38422 KB zlib stored, 261720 readings, build 1.07s, 1.5 ms/frame)

- [x] G7: every rule in rules.rs has a non-empty rationale (test)
  CHECK: cargo test --manifest-path api/Cargo.toml rules_have_rationale 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 201 filtered out; finished in 0.00s

- [x] G8: the REST route GET /v1/frames answers a oneshot request with content-type application/x-evf, gzip content-encoding and a body whose header parses (test frames_rest_route)
  CHECK: cargo test --manifest-path api/Cargo.toml frames_rest_route 2>&1 | grep "test result"
  EXPECT: /test result: ok\. 1 passed; 0 failed/
  EVIDENCE: test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 201 filtered out; finished in 0.05s
