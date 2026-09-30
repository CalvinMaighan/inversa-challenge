# Gates: T11 frames + hotspots (fable)

Scope:
- `hotspot/{rules,score,backtest}.rs` implement PRD §8: `score = density × activity × access` per 0.01° cell (C15) and frame.
  - Density uses a per-species half-life kernel; NAS/GBIF history counts at 0.2 weight.
  - Rules carry a rationale string each.
  - rayon parallelism across cells.
- `explain(cell, species, at)` returns each term's contribution.
- `backtest(species, days)` reports the top-10% hit rate against the 10% baseline.
- `frames.rs`:
  - builds EVF1 (C4) frames;
  - `spawn_builder` subscribes to Hub RowsWritten, debounces 5 s, rebuilds the affected frames into the `frames` table, and publishes FramesUpdated;
  - exposes `pub async fn chunk(db, from_ms, to_ms, step_min) -> Vec<u8>`.
- `spec/frames/sample.evf` is the golden file.

- [ ] G1: api tests pass
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G2: score unit tests against hand-computed cells for all 4 species, including a cold-stun iguana case and a lionfish no-access (waves) case
  CHECK: cargo test --manifest-path api/Cargo.toml hotspot 2>&1 | grep -E "running|test result"
  EXPECT: /running ([4-9]|[1-9][0-9]) tests[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: EVF1 golden round-trip; the Rust writer output byte-equals spec/frames/sample.evf for the fixed seed input
  CHECK: cargo test --manifest-path api/Cargo.toml evf_golden 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: the TS reader (apps/web/shared/frames.ts readEvfHeader) parses the golden file
  CHECK: bun -e 'import {readEvfHeader} from "./apps/web/shared/frames.ts"; const b=await Bun.file("spec/frames/sample.evf").arrayBuffer(); console.log(JSON.stringify(readEvfHeader(new DataView(b))))'
  EXPECT: /"speciesCount":4/
  EVIDENCE: pending

- [ ] G5: backtest returns hitRate and baseline=0.1 on a seeded dataset (test)
  CHECK: cargo test --manifest-path api/Cargo.toml backtest 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: a release-mode benchmark for 30 days × 96 frames/day on the full 340×320 grid prints its measured duration
  CHECK: cargo test --release --manifest-path api/Cargo.toml bench_frames -- --ignored --nocapture 2>&1 | grep -E "BENCH frames"
  EXPECT: /BENCH frames \d+ in [0-9.]+ ?(ms|s)/
  EVIDENCE: pending

- [ ] G7: every rule in rules.rs has a non-empty rationale (test)
  CHECK: cargo test --manifest-path api/Cargo.toml rules_have_rationale 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending
