# Gates: T18 HUD, timeline, evidence drawer (opus)

Scope: `apps/web/client/hud/**`, excluding `hud/missions`:
- A top bar with C3 feed chips, UTC and local clocks, cursor coordinates and a theme mode switch.
- A bottom timeline scrubber with gap hatching, alert bands, a sighting sparkline, and play/step controls.
- Detection brackets plus a label arbiter (after God's Eye View `detection.js`/`labelArbiter.js`), and a scope-mask focus mode.
- An evidence drawer showing the record, pretty-printed raw payload, source link, lag, and duplicate/conflict/revision badges.
- Hotspot explain and backtest panels.
- URL-hash share links (after God's Eye View `sharelink.js`).

- [ ] G1: HUD tests pass (share-link round trip, label arbiter collision, gap segmentation from flags, feed chip state mapping)
  CHECK: cd apps/web && bun test tests/client/hud 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: pending

- [ ] G2: scrubbing 96 frames makes zero network requests, and the median frame change is under 16 ms; a Playwright script prints `SCRUB median=<ms> requests=0`
  CHECK: cd apps/web && bun run e2e:scrub 2>&1 | grep SCRUB
  EXPECT: /SCRUB median=(1[0-5]|[0-9])(\.\d+)? requests=0/
  EVIDENCE: pending

- [ ] G3: cloud-gap hatching renders for a fixture with flagged cells (manual screenshot path)
  EVIDENCE: pending

- [ ] G4: opening a share link restores camera, time and layers (test)
  CHECK: cd apps/web && bun test tests/client/hud -t "share link" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9] pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G5: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: pending
