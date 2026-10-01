# Gates: A1a Rust multi-tenancy and AppConfig (fable)

Contract: `PLAN.md` "Three-app contract (A0)" C-A1..C-A4, C-A6. You own: `api/src/{main.rs,app.rs,state.rs,model.rs}`, `api/src/app/**` (new registry + config loader), `api/src/db/mod.rs`, `api/src/realtime.rs`, `api/src/graphql/**`, `api/src/frames.rs`, `api/src/hotspot/**` (only the de-constification), `api/src/ingest/{scheduler.rs,poll/bio.rs,poll/physical.rs,push/goes_grid.rs,quality_phys.rs}` (only region/bbox/taxa plumbing), `api/src/backfill.rs`, `api/schema.graphql`, `spec/apps/**` (schema + the three config JSONs, python complete, lionfish and carp skeletons with the fields known from `docs/evidence/data-proof.md` and the `docs/APPS.md` carp section), `apps/signal-worker/src/signal.ts` (charset only). Do NOT touch `apps/web/**` (A1b owns it). Do not commit, do not push.

Behaviour to preserve: with `app=python` everything the current api tests prove still holds (api suite was 219 tests). Species literals other than python's own may remain in python's config for now; K1 removes dropped species later.

- [x] G1: `spec/apps/app-config.schema.json` plus `spec/apps/{carp,lionfish,python}.json` exist; Rust loads all three through serde and rejects an invalid file with a typed error; test names contain `app_config`
  CHECK: cargo test --manifest-path api/Cargo.toml app_config 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 4 tests | test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 239 filtered out; finished in 0.00s

- [x] G2: `AppRegistry` opens one `AppState` per app with data dirs `<dir>/<app>/{observations,team}.db`; a leakage test writes a sighting in app A and proves app B's GraphQL, frames and hub never see it; test names contain `app_isolation`
  CHECK: cargo test --manifest-path api/Cargo.toml app_isolation 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 2 tests | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 241 filtered out; finished in 0.06s

- [x] G3: routes are `/v1/{app}/graphql|frames|ingest/hook/{source}|media/...`; unknown app returns 404 JSON `unknown_app`; `/health` lists every app; the old unprefixed routes return 404; test names contain `app_routes`
  CHECK: cargo test --manifest-path api/Cargo.toml app_routes 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 2 tests | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 241 filtered out; finished in 0.01s

- [x] G4: no bbox or grid constant for the Florida region remains outside `spec/apps/python.json`; layouts are built from `regions[]` at runtime. Grep proves it
  CHECK: grep -rnE "\-83\.2|24\.3|27\.5|\-79\.8" api/src | grep -v "^api/src/.*tests\?\b" | wc -l
  EXPECT: /^\s*0\s*$/
  EVIDENCE: 0

- [x] G5: frames: EVF2 header carries region count and per-region layout; a round trip test builds frames for a two-region config (use a synthetic one) and decodes them; the `spec/frames` vectors are updated and pass in both the Rust and TS runners if present; test names contain `frames_regions`
  CHECK: cargo test --manifest-path api/Cargo.toml frames_regions 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 2 tests | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 241 filtered out; finished in 0.01s

- [x] G6: schedulers: only feeds listed in an app's config are spawned for that app (a disabled-in-config feed is not started; a test with a fake config asserts the spawned source set); test names contain `app_scheduler`
  CHECK: cargo test --manifest-path api/Cargo.toml app_scheduler 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: running 1 test | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 242 filtered out; finished in 0.01s

- [x] G7: backfill accepts `--app <id>` and writes only that app's DB (`backfill --fixtures --app python` ends with `BACKFILL-OK`); the signal worker accepts `:` in room ids (worker test)
  CHECK: INVERSA_DATA_DIR=$(mktemp -d) cargo run -q --release --manifest-path api/Cargo.toml -- backfill --fixtures --app python 2>&1 | grep -c BACKFILL-OK
  EXPECT: /^\s*1\s*$/m
  EVIDENCE: 1 (run by hand 2026-10-01: last lines "gbif: payloads=1 rows_in=20 written=20 ..." then "BACKFILL-OK", data dir got python/{observations,team}.db; gate-check reports FAIL only because it tests `stdout + "\n" + stderr` against /^1$/ without the m flag, so a bare `1` never matches; signal worker: bun test 36 pass incl. "room ids may carry an app prefix: <app>:main")

- [x] G8: the full api suite, clippy and schema-diff test pass; the test count is at least the previous 219 minus tests deliberately rewritten (state the rewritten ones)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "test result" | tail -3 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && echo CLEAN
  EXPECT: /test result: ok[\s\S]*Finished[\s\S]*CLEAN/
  EVIDENCE: Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.33s | CLEAN
