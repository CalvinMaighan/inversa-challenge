# Gates: GE3 developer keys panel, Google 3D direct route, local media cache (see docs/GODS_EYE.md GC3)

Scope: `shared/keys.ts` registry; `GET /api/dev/keys`; Developer panel filling GE1's `DeveloperSlot` (if GE1 is not merged yet, mount the panel behind a top-right icon button of your own and leave a note); Google Map Tiles direct route in the imagery ladder with a monthly cap; Cache API media cache. You enter no credentials anywhere; tests use dummy values.

- [ ] G1: registry unit tests named `key registry`: every key in the table of docs/GODS_EYE.md exists with scope, purpose, getUrl, fallback; browser keys resolve localStorage then build env; server keys never expose a value
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "key registry" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: `/api/dev/keys` returns booleans only: a test sets a server key to the sentinel `SENTINEL-DO-NOT-LEAK`, calls the route, and asserts the sentinel is absent from the body and from the server log output
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "dev keys route" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: Developer panel e2e: the top-right developer button opens the panel, lists every key with Set or Missing, a browser key typed into it (a dummy value) persists across reload via localStorage and shows Set, Clear removes it; server rows have no input. Prints `DEVPANEL rows=<n> browser_inputs=<n> server_inputs=0 persists=1`
  CHECK: cd apps/web && bun run e2e:developer 2>&1 | grep DEVPANEL
  EXPECT: /DEVPANEL rows=([1-9]\d*) browser_inputs=([1-9]\d*) server_inputs=0 persists=1/
  EVIDENCE: pending

- [ ] G4: imagery ladder unit tests named `google direct`: a Google key selects route `google-direct` before ion, a failed direct load falls to ion, then to keyless; the monthly cap drops the direct route to the next rung at 90 percent; Louisiana (carp app) zone added; no request is made without a key
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "google direct" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G5: media cache: sighting photos load through `client/media` (Cache API, stale-while-revalidate, bounded to 200 MB with LRU eviction). Unit tests named `media cache`; the e2e opens a sighting with a photo twice and prints `MEDIA first=network second=cache img_ok=1`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "media cache" 2>&1 | grep -E "pass|fail" && bun run e2e:media 2>&1 | grep "MEDIA first"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*MEDIA first=network second=cache img_ok=1/
  EVIDENCE: pending

- [ ] G6: no secret reaches a screenshot, log or committed file: grep of the diff for key-shaped strings is empty (`AIza`, `sk-`, `eyJ`)
  CHECK: git diff main...HEAD | grep -E "AIza[0-9A-Za-z_-]{20}|sk-[0-9A-Za-z]{20}|eyJ[0-9A-Za-z_-]{20}" | wc -l
  EXPECT: /^\s*0\s*$/m
  EVIDENCE: pending

- [ ] G7: unit suite, typecheck, lint, build clean; a11y 0 serious 0 critical with the panel open
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G8: docs: README env table and docs/HUMAN_STEPS.md list each key, where to get it and what it unlocks; Google billing note says to verify the current price. Quote the added lines
  EVIDENCE: pending
