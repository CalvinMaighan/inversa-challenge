# Gates: T44 every species is a first-class sighting (fable)

Scope:
- Grey "other" dots become real species. Every sighting shows its common and scientific name, photo, and a short plain "About this species" (native range, why it's a problem) from iNaturalist taxa data, fetched server-side and cached.
- The species bar becomes the top introduced animals in the current window (by count), with Inversa's focus species pinned. Plants and insects sit behind their own chips, off by default.
- The window selector offers 2 days / 7 days / 30 days, default 7 days, with the reason (iNat upload lag) stated plainly.
- Default backfill is 7 days.
- Stale API binaries fail soft (a missing GraphQL field degrades, not errors).

- [ ] G1: api tests including taxon enrichment (iconic group, iNat taxon id, summary, photo, Wikipedia URL), cached in SQLite, batched at 30 ids per iNat call, rate-governed; test names contain `taxon_info`
  CHECK: cargo test --manifest-path api/Cargo.toml taxon_info 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: clicking a grey dot on the real stack (a brown anole or Cuban tree frog from real data) opens a card with the common name, scientific name, an About line and a photo; e2e prints `SPECIESCARD name=<common> sci=1 about=1 photo=1 error=0`
  CHECK: cd apps/web && bun run e2e:speciescard 2>&1 | grep SPECIESCARD
  EXPECT: /SPECIESCARD name=[A-Za-z][^ ]* sci=1 about=1 photo=1 error=0/
  EVIDENCE: pending

- [ ] G3: the species bar lists the top introduced animals in the window (focus species pinned), chip counts equal the DB counts for that window, and switching 2d/7d/30d changes the counts; e2e prints `SPECIESBAR chips>=6 counts=ok window_7d>window_2d plants_default=off`
  CHECK: cd apps/web && bun run e2e:speciescard 2>&1 | grep SPECIESBAR
  EXPECT: /SPECIESBAR chips>=6 counts=ok window_7d>window_2d plants_default=off/
  EVIDENCE: pending

- [ ] G4: graceful degradation. The drawer and agent queries do not hard-fail when the API lacks an optional field (simulated old schema); web test named "schema tolerant evidence"
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "schema tolerant evidence" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G5: `bun run data` defaults to 7 days, and after it the local DB's 7-day iNat count is within 10% of iNat's own count for the bbox (manual: quote both numbers)
  EVIDENCE: pending

- [ ] G6: the agent answers "what invasive animals were seen near Homestead this week?" with named species and counts, citing them (live, doppler); live eval still at the leaf-T39 threshold (manual: quote the answer's first lines and the EVAL line)
  EVIDENCE: pending

- [ ] G7: web tests, typecheck, lint, api suite and clippy clean; e2e:firstload, e2e:species and e2e:links still pass
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*Finished[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G8: screenshots (looked at) `docs/evidence/species-card-other.png` and `species-bar-7d.png`
  EVIDENCE: pending
