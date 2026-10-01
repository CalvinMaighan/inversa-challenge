# Gates: K1 only three apps, only their species (opus)

Policy (user): "forget all of the other species, use data feeds and websockets that source relevant information for all 3 species only." The python app tracks Burmese python only (*Python bivittatus*; the Everglades). Lionfish tracks *Pterois volitans/miles* only. Carp tracks conditions (no species). Tegu, iguana, every "other introduced animal", plants, insects and the species-category popover are removed, not hidden. Feeds and adapters serving none of the three apps are removed. Read `docs/ingest-modes.md` (feeds to remove), `docs/OVERNIGHT_BRIEF.md` R14, `spec/apps/python.json`, `api/migrations/observations/0001_init.sql` (taxa seed 1-4), `apps/web/shared/species-categories.ts`, and the hotspot code. You own removal across `api/`, `apps/web/`, `spec/`, `scripts/`, fixtures and docs (except `docs/evidence/` history and `PLAN.md`/`gates/leaf-T*.md` history). Do not change agent prompts beyond deleting removed-species text (AG leaves are merged). Commit on your worktree branch, no push. macOS has no `timeout`.

- [ ] G1: python app config has exactly one taxon (Burmese python): `spec/apps/python.json` taxa, half-life, rules, iNat/GBIF/NAS keys; the other three taxa are removed from config, migrations seed (new migration that deletes taxa 2 to 4 and their sightings if present, safe on a fresh DB), `Focus` enum, `hotspot::Species`/taxa indices, frames species count (EVF2 `speciesCount` 1 for python), GBIF `TAXON_KEYS`, iNat ids, NAS `GENERA`; all rules for removed species deleted; python tests rewritten for one taxon; schema/conformance corpus updated
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /test result: ok[\s\S]*[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: no removed-species literal remains in code, config or fixtures outside history: zero matches of `tegu`, `iguana`, `Salvator`, `Iguana iguana`, `anole`, `Cuban tree frog` (case-insensitive) in `api/src api/migrations api/fixtures apps/web/client apps/web/server apps/web/shared apps/web/eval apps/web/e2e apps/web/tests spec scripts README.md docs/PRD.md docs/questions.md docs/demo-script.md docs/interview-notes.md docs/brief-compliance.md`; the only allowed hits are inside boundary-question text asserting a refusal (listed by id in the evidence), and `docs/evidence`, `gates/leaf-T*`, `PLAN.md` history
  CHECK: grep -rliE "tegu|iguana|salvator|anole|tree frog" api/src api/migrations api/fixtures apps/web/client apps/web/server apps/web/shared apps/web/eval apps/web/e2e spec scripts README.md docs/PRD.md docs/demo-script.md docs/interview-notes.md docs/brief-compliance.md | wc -l
  EXPECT: /^\s*0\s*$/m
  EVIDENCE: pending

- [ ] G3: the generic species machinery is gone: species bar with introduced-animal chips, category popover and category icons, "Other" bucket, plants and insects chips, taxon-info enrichment for arbitrary taxa (T44), `speciesCounts` groups for other taxa, the 2/7/30-day window selector that only served the multi-species view, `species-categories.ts`, SpeciesCard code that exists only for arbitrary taxa; python and lionfish keep a single-species chip; the species popover in the HUD is now the app selector only; `e2e:species`, `e2e:speciescard` scripts and their gates are removed or rewritten to the single-species behaviour (list each); web tests rewritten
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ (pass|fail)" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*CLEAN/
  EVIDENCE: pending

- [ ] G4: feeds and sockets for none of the three apps are removed: per `docs/ingest-modes.md` "feeds to remove" (the `web` hook source if unused, iNat introduced-animals background query and cursor, CO-OPS for lionfish, Open-Meteo forecast and NWS for lionfish, GOES LSTC/ACMC/FDCC for lionfish and carp, NASA FIRMS/aisstream/Firecrawl mentions); every remaining source in `api/src/ingest` is registered by at least one app config (test `sources_all_used`), and every config feed has an adapter; `/health` per app lists only its feeds
  CHECK: cargo test --manifest-path api/Cargo.toml sources_all_used 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: python data and frames are regenerated for one taxon: `backfill --app python --fixtures` ends `BACKFILL-OK`; golden frames (`spec/frames/*.evf`) regenerated and both Rust and TS decoders pass; fixtures for the removed species deleted; the python hotspot, backtest and explain tests pass on python only
  CHECK: INVERSA_DATA_DIR=$(mktemp -d) cargo run -q --release --manifest-path api/Cargo.toml -- backfill --fixtures --app python 2>&1 | grep -c BACKFILL-OK
  EXPECT: /^\s*1\s*$/m
  EVIDENCE: pending

- [ ] G6: agent and questions: `spec/apps/questions/python.json` and its holdout no longer ask about removed species except as boundary refusals ("what about tegus?" must refuse, naming the app's scope); `bun scripts/check-questions.ts` still prints all three apps with 10/10 categories and the python counts drop to what remains (state them); no-answer-key test passes; one blind live run `--app python` (doppler) is at least 90% with boundary 100% and ungrounded 0 (quote it; the full benchmark is re-run later by the driver)
  CHECK: bun scripts/check-questions.ts 2>&1 | tail -2
  EXPECT: /QUESTIONS carp=\d+ lionfish=\d+ python=\d+ categories=10\/10 ok/
  EVIDENCE: pending

- [ ] G7: e2e and stack: `e2e:stack`, `e2e:appselect`, `e2e:firstload` for all three apps, `e2e:carp`, `e2e:lionfish`, `e2e:dm`, `e2e:notes`, `e2e:team` still pass after the removal (quote each OK line); `bun run check` and clippy clean (state counts)
  CHECK: bun run check 2>&1 | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /CHECK-OK[\s\S]*Finished/
  EVIDENCE: pending
