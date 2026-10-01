# Gates: STAB1 stabilise the graded e2e checks that do not need a live model (fable)

Why: after all leaves merged, `bun scripts/grade.ts --skip-live --no-write` (driver, 2026-10-01 20:20Z) scored 48.1/100 with FAIL on checks that had each passed inside their own leaf: `e2e:a11y`, `e2e:layout`, `e2e:quality`, `e2e:firstload`, `e2e:appselect` (fixed by the driver: its lionfish preset check now asserts the view contains the four-area hull), `e2e:dm`, `e2e:notes`, `e2e:evidence` (lionfish), and `prod-ready` timed out after 900 s. The OpenRouter key is out of credit (402), so **no step in this leaf may call the live model**; checks that need it (agent answers, evidence citation, perf, a11y python flow with the live agent) are out of scope tonight: leave them, and where a script mixes live and non-live steps, make the non-live parts independently runnable (`--no-agent` flag or similar) and report which lines need the model. Known regressions found by the driver: `e2e:layout` python prints `MOBILE app=python overflow=10` (phone states each overflow by 2 elements; GRA's helper measured 0 before the GRB/BUG1 merges) and `mobile=fail`; `e2e:firstload -- --app carp` prints `sites=7/8` and exits 1 (one carp site not drawn on first load).

You own: anything needed to fix regressions: `apps/web/client/**`, `apps/web/e2e/**`, `spec/apps/*.json` copy, `docs/grading/rubric.json` ONLY where a timeout is simply too short for a legitimately long build+run (raise it, log why; never loosen a bound or pattern). Work in the worktree the driver created for you (`cd`/`git -C` only there), commit there, never push. macOS has no `timeout`; do not leave hung processes (check `ps` for stray next/workerd/inversa-api from earlier runs that belong to you; do not kill processes you did not start). `E2E_SKIP_BUILD=1` after one clean build; do not edit apps/web while an e2e against `next dev` is running. Do not run anything that calls the model; Doppler is not needed for this leaf.

For each failure: reproduce, find the root cause (app regression vs script defect vs genuine flake), fix at the root, add a test where sensible, and record cause and fix in the report. Flaky means: reproduce 3 times and fix the race, do not add retries that mask bugs.

- [ ] G1: `e2e:layout` prints for each of python, carp, lionfish: `MOBILE app=<id> overflow=0 hscroll=0 pagescroll=0 ...` and `LAYOUT app=<id> ... legend=ok tooltip=ok ... mobile=ok`
  CHECK: cd apps/web && for a in python carp lionfish; do E2E_SKIP_BUILD=1 bun run e2e:layout -- --app $a 2>&1 | grep -E "^MOBILE|^LAYOUT"; done
  EXPECT: /MOBILE app=python overflow=0 hscroll=0[\s\S]*LAYOUT app=python [^\n]*legend=ok tooltip=ok[^\n]*mobile=ok[\s\S]*MOBILE app=carp overflow=0[\s\S]*LAYOUT app=carp [^\n]*mobile=ok[\s\S]*MOBILE app=lionfish overflow=0[\s\S]*LAYOUT app=lionfish [^\n]*mobile=ok/
  EVIDENCE: pending

- [ ] G2: `e2e:firstload` exits 0 and prints `FIRSTLOAD app=<id> records=<n> errors=0 ...` for all three apps; carp shows all 8 sites on first load (`sites=8/8`)
  CHECK: cd apps/web && for a in python carp lionfish; do E2E_SKIP_BUILD=1 bun run e2e:firstload -- --app $a 2>&1 | grep -E "^FIRSTLOAD"; done
  EXPECT: /FIRSTLOAD app=python records=\d+ errors=0[\s\S]*FIRSTLOAD app=carp records=\d+ errors=0[^\n]*sites=8\/8[\s\S]*FIRSTLOAD app=lionfish records=\d+ errors=0/
  EVIDENCE: pending

- [ ] G3: `e2e:a11y -- --app carp` and `--app lionfish` print `AXE app=<id> serious=0 critical=0 scans=<n>` and `KEYBOARD-OK app=<id>` (python's a11y flow uses the live agent: make its non-agent scans runnable without the model via a flag, report which lines need the model)
  CHECK: cd apps/web && for a in carp lionfish; do E2E_SKIP_BUILD=1 bun run e2e:a11y -- --app $a 2>&1 | grep -E "^AXE|^KEYBOARD"; done
  EXPECT: /AXE app=carp serious=0 critical=0 scans=\d+[\s\S]*KEYBOARD-OK app=carp[\s\S]*AXE app=lionfish serious=0 critical=0 scans=\d+[\s\S]*KEYBOARD-OK app=lionfish/
  EVIDENCE: pending

- [ ] G4: `e2e:quality -- --app <id>` prints `QUALITY app=<id> cases=<n> stale=ok missing=ok conflict=ok shots=<n>` for all three apps, shots verified on disk
  CHECK: cd apps/web && for a in python carp lionfish; do E2E_SKIP_BUILD=1 bun run e2e:quality -- --app $a 2>&1 | grep -E "^QUALITY"; done
  EXPECT: /QUALITY app=python [^\n]*stale=ok missing=ok conflict=ok[\s\S]*QUALITY app=carp [^\n]*stale=ok missing=ok conflict=ok[\s\S]*QUALITY app=lionfish [^\n]*stale=ok missing=ok conflict=ok/
  EVIDENCE: pending

- [ ] G5: messaging: `e2e:dm` and `e2e:notes` pass three times in a row each (`DM chars_streamed=40/40 ... persist=ok reload=ok typing=ok presence=ok`, `NOTES ... live_edit=ok caret=ok converge=ok presence=ok`); the parts that need the live model (the NOTES-AGENT line) are split behind a flag and reported, the rest never uses the model; root cause of the earlier timeouts ("B leaves, A shows away") found and fixed, not retried around
  CHECK: cd apps/web && for i in 1 2 3; do E2E_SKIP_BUILD=1 bun run e2e:dm 2>&1 | grep -E "^DM "; done
  EXPECT: /(DM chars_streamed=40\/40[^\n]*presence=ok[\s\S]*){3}/
  EVIDENCE: pending

- [ ] G6: `prod-ready`: find out why the grader's `e2e:prod` check timed out after 900 s (build time vs a hang); fix a hang; if the legitimate build+boot of the production bundle takes longer, set the rubric timeout to a measured value with margin and say so; `e2e:prod -- --app <id>` prints `PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok degraded=ok` and the `HEADERS ...` line without any model call (the ratelimit/costcap checks must not hit the model)
  CHECK: cd apps/web && bun run e2e:prod 2>&1 | grep -E "^PROD|^HEADERS"
  EXPECT: /PROD app=carp [^\n]*degraded=ok[\s\S]*PROD app=lionfish [^\n]*degraded=ok[\s\S]*PROD app=python [^\n]*degraded=ok[\s\S]*HEADERS coop=ok coep=ok csp=ok nosniff=ok referrer=ok/
  EVIDENCE: pending

- [ ] G7: the grader, skipping live checks, no longer fails on any of the above: `bun scripts/grade.ts --skip-live --no-write` prints the GRADE lines; quote them and the TOTAL; every FAIL left is explained (needs the live model, or a real defect you could not fix: say which) and no check was weakened (show the rubric diff, expected to be timeouts only)
  CHECK: bun scripts/grade.ts --skip-live --no-write 2>&1 | grep -E "^GRADE |^TOTAL" | tail -30
  EXPECT: /TOTAL [\d.]+\/100/
  EVIDENCE: pending

- [ ] G8: web tests, typecheck, lint, api tests and clippy clean (state counts); `bun scripts/check-removed-species.ts` and `bun scripts/check-questions.ts` still pass
  CHECK: bun run check 2>&1 | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /CHECK-OK[\s\S]*Finished/
  EVIDENCE: pending
