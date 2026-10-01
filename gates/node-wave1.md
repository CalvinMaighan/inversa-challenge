# Gates: wave 1 integration (A1a + A1b + M1 on pivot/three-apps) (opus, fable if stuck)

You work in your worktree off `pivot/three-apps` (HEAD includes all three merged leaves). Owns: whatever is needed to make the three leaves agree; edit across `api/`, `apps/web/`, `spec/apps/`, root `package.json`, `deploy/` health checks. Do not push; commit on your worktree branch.

Known mismatches to reconcile (config source of truth is `spec/apps/*.json` + `app-config.schema.json` as implemented in `api/src/app/config.rs` with `deny_unknown_fields`; web zod in `apps/web/shared/apps/schema.ts` was written to the contract before it existed):
- web accepts `windows.default/options`, `bbox` object, `camera.altitudeM`, `legend` map, `agent.persona/scope/tools/refusal`; Rust has `windows.defaultHours/optionsHours`, `bbox:[W,S,E,N]`, `camera.heightM`, `legend{str:str}`, `agent{persona,scope,tools,refusal}`. Make the web zod read the real files (strict, no tolerant spellings), point the tsconfig alias `app-configs/*` at `spec/apps/*`, delete `apps/web/tests/fixtures/apps` duplicates (tests use `spec/apps`).
- Add the accepted contract fields to BOTH the Rust serde + JSON schema and the web zod: `taxa[].short,scientific,line,aliases,category` (optional), `copy.about`, `copy.region`, `copy.timezone` (IANA).
- `/health` shape is `{status, defaultApp, apps:[{id,name,kind,provisional,regions,taxa,feeds:[...]}]}` (503 when degraded); web `health.ts` must parse exactly that, drop the guesses; deploy healthchecks that grep body `ok` are updated.
- GraphQL `Message` exposes `to` and `thread` (map `MessageView.to/thread`), `api/schema.graphql` updated with the schema-diff test passing.
- EVF2: web `shared/frames.ts` reads `regionCount` at offset 68 and per-region descriptors, `EVF_SPECIES` becomes per-app taxa order; `spec/frames/two-regions.evf` decodes in TS with the expectations in `spec/frames/README.md`.
- Root `package.json` `data` script uses `--app` (loop the three apps; python also runs the cold-snap scene).
- e2e scripts still on `/v1/graphql` or board `everglades`: `team.ts`, `notes.ts`, `dbworker.ts`, `panels.ts`, `perf-poll.ts`, `dm.ts`; move them to `/v1/<app>/` and `<app>:main` (default app python for the old scenarios, carp otherwise).
- Data layout migration note for deploy: one-time move of existing python data into `<dir>/python/`; script `deploy/migrate-app-dirs.sh` (idempotent).

- [ ] G1: web conformance: web zod loads the three real files in `spec/apps` and rejects a file with an unknown or missing field; Rust and TS agree on a shared invalid-file corpus in `spec/apps/invalid/*.json` (each file named for the field it breaks); test names `app config conformance`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "app config conformance" 2>&1 | grep -E "pass|fail" && cargo test --manifest-path ../../api/Cargo.toml app_config 2>&1 | grep "test result"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: the real stack works end to end for every app: e2e boots Axum with all three apps and the web build, and for each app loads `/?app=<id>` and prints `STACK app=<id> health=ok graphql=ok frames=<ok|none> console_errors=0` (carp frames none)
  CHECK: cd apps/web && bun run e2e:stack 2>&1 | grep -c "^STACK app=.* health=ok graphql=ok .* console_errors=0"
  EXPECT: /^\s*3\s*$/m
  EVIDENCE: pending

- [ ] G3: `e2e:appselect`, `e2e:dm`, `e2e:notes`, `e2e:team`, `e2e:firstload` run against the real multi-app API (not only fixtures) and print their usual OK lines; for `e2e:firstload` run per app
  CHECK: cd apps/web && for s in appselect dm notes team; do bun run e2e:$s 2>&1 | tail -3; done
  EXPECT: /APPSELECT apps=3[\s\S]*DM chars_streamed=40\/40[\s\S]*NOTES [^\n]*live_edit=ok[\s\S]*TEAM/
  EVIDENCE: pending

- [ ] G4: GraphQL `Message.to/thread` visible via the `board` query in a Rust test named `message_thread_graphql` and in the TS client types
  CHECK: cargo test --manifest-path api/Cargo.toml message_thread_graphql 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: frames: TS decodes `spec/frames/two-regions.evf` per README expectations and the live lionfish frames from the fixture backfill; test names `frames regions`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "frames regions" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G6: `deploy/migrate-app-dirs.sh` is idempotent on a temp tree (run twice, same result) and `bash -n deploy/*.sh` is clean
  CHECK: bash -n deploy/migrate-app-dirs.sh && bash deploy/test-migrate-app-dirs.sh 2>&1 | tail -2
  EXPECT: /MIGRATE-OK idempotent/
  EVIDENCE: pending

- [ ] G7: whole suites clean: `bun run check` (lint, typecheck, web tests, api tests) and clippy -D warnings; state counts
  CHECK: bun run check 2>&1 | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /CHECK-OK[\s\S]*Finished/
  EVIDENCE: pending
