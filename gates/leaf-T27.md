# Gates: T27 data-quality end-to-end

Scope: seed each R5 case (stale, missing, duplicate, conflicting, late). Each one must be visible in the UI badge, in the evidence drawer, and in the agent's wording.

- [x] G1: a fixture seeder produces all 5 cases, and a GraphQL check confirms each (test e2e_quality_cases)
  CHECK: cargo test --manifest-path api/Cargo.toml e2e_quality_cases 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running [1-9][\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 208 filtered out; finished in 10.83s

- [x] G2: the agent eval includes the 5 quality questions and states each case; the live eval prints the quality subset `EVAL quality passed 5/5`
  CHECK: bun run eval 2>&1 | grep "EVAL quality"
  EXPECT: EVAL quality passed 5/5
  EVIDENCE: EVAL quality passed 5/5 (gate-check run). Consistency on the final agent code, full `bun run eval`, consecutive: run 1 `EVAL quality passed 5/5` `EVAL passed 15/15`; run 2 5/5, 15/15; run 3 5/5, 15/15; then the gate-check run, 5/5 (4 consecutive). Before the fixes, 3 quality-only runs gave 5/5, 4/5, 5/5 (quality-stale-feeds cited 1 of 3 non-nominal feeds). Fixes: `feedSummary.mention` gives each non-nominal feed a ready `cite` marker and age; `Sighting.ingestedAt` lets the sightings tool flag `arrivedLate`, and quality-duplicates-shark-valley now also requires the late NAS record to be named (`/\blate\b|arrived … after/`), so the five quality questions cover stale, missing, duplicate+late, and conflicting (SST and ID flip).

- [x] G3: screenshots of the UI badge and drawer for each case (manual: paths under docs/evidence/quality/)
  EVIDENCE: `bun run e2e:quality` on the real stack prints `QUALITY cases=5 shots=11`; each drawer is asserted to show its badge before the shot, and every image was looked at. stale: docs/evidence/quality/stale-chip.png (WEB chip, stale tone, 3d) and stale-drawer.png (WEB FEED STALE badge, feed note "newest observation is 3d old; max latency is 1d"); missing: missing-cloud-globe.png (cloud and bad-DQF pixels hatched on the LST layer), missing-cloud-drawer.png (MISSING · CLOUD), missing-bad-dqf-drawer.png (MISSING · BAD DQF), missing-fetch-failed-drawer.png (FETCH FAILED, the normalize error); duplicate: duplicate-drawer.png (DUPLICATE OF sighting:10) and duplicate-canonical-drawer.png (1 DUPLICATE); conflicting: conflict-idflip-drawer.png (1 REVISION, 1 CONFLICT, taxon Salvator merianae → Tupinambinae) and conflict-sst-drawer.png (1 CONFLICT, linked to the satellite pixel); late: late-drawer.png (LATE · ARRIVED 139d 7h AFTER, ingest lag 139d 7h). UI fixes found by looking: flagged pixels were filled from the neighbouring pixel in the frames and never hatched with one GOES scan (new `ENV_FLAGGED` sentinel, in-cell sampling); the drawer had no late / missing / failed-fetch / feed-state badges and no feed note; chip notes were hover-only (a chip now opens its last fetch run).
