# Gates: T37 live mode (PLAN.md C18, done inside the T23/T24 integration leaf)

Scope: at the live edge TIME follows now; new rows reach the screen without a reload. The chain is Axum write, then the 5 s frame debounce, then `framesUpdated`, then the gql worker, then the db worker (refetches the changed hours and expires its query cache), then a grid bump, then the globe layers and the HUD redraw. Alerts and stations refetch on the data revision. `scripts/dev.ts` sets a dev-only `INGEST_HOOK_SECRET`.

- [x] G1: live logic tests pass (window follow and live badge, retime, cache expiry on framesUpdated, moved window reallocation)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/client/state/time.test.ts tests/client/hud/timeline.test.ts tests/client/threads/engine.test.ts 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 32 pass | 0 fail

- [x] G2: on the real stack, a signed hook sighting and alert appear on the globe (picked by evidence id), and the HUD sparkline and the web feed chip update, all within 15 s and with no reload. Prints `LIVE sighting_ms=<n> alert_ms=<n> ... reload=0`
  CHECK: cd apps/web && bun run e2e:live 2>&1 | grep "^LIVE"
  EXPECT: /^LIVE sighting_ms=([0-9]{1,4}|1[0-4][0-9]{3}) alert_ms=([0-9]{1,4}|1[0-4][0-9]{3}) sparkline_ms=([0-9]{1,4}|1[0-4][0-9]{3}) feed_ms=([0-9]{1,4}|1[0-4][0-9]{3}) reload=0$/m
  EVIDENCE: LIVE sighting_ms=6559 alert_ms=6559 sparkline_ms=5047 feed_ms=6559 reload=0

- [x] G3: `bun run dev` turns the web hook on with a random dev-only secret, printed once
  CHECK: grep -c "generatedHookSecret" scripts/dev.ts
  EXPECT: /^[3-9]$/m
  EVIDENCE: 3

- [x] G4: screenshot of the live state after the hook rows landed, looked at: the python dot and the Freeze Warning polygon over Homestead, LIVE badge
  EVIDENCE: docs/evidence/live.png: LIVE badge, timeline on 2026-09-30 22:45Z, the hook's python marker (P) west of Homestead and the orange Freeze Warning outline around it, taken after `LIVE sighting_ms=6008 alert_ms=6008 sparkline_ms=4972 feed_ms=6008 reload=0`
