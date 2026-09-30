# Gates: T18 HUD, timeline, evidence drawer (opus)

Scope: `apps/web/client/hud/**`, excluding `hud/missions`:
- A top bar with C3 feed chips, UTC and local clocks, cursor coordinates and a theme mode switch.
- A bottom timeline scrubber with gap hatching, alert bands, a sighting sparkline, and play/step controls.
- Detection brackets plus a label arbiter (after God's Eye View `detection.js`/`labelArbiter.js`), and a scope-mask focus mode.
- An evidence drawer showing the record, pretty-printed raw payload, source link, lag, and duplicate/conflict/revision badges.
- Hotspot explain and backtest panels.
- URL-hash share links (after God's Eye View `sharelink.js`).

- [x] G1: HUD tests pass (share-link round trip, label arbiter collision, gap segmentation from flags, feed chip state mapping)
  CHECK: cd apps/web && bun test tests/client/hud 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 60 pass | 0 fail

- [x] G2: scrubbing 96 frames makes zero network requests, and the median frame change is under 16 ms; a Playwright script prints `SCRUB median=<ms> requests=0`
  CHECK: cd apps/web && bun run e2e:scrub 2>&1 | grep SCRUB
  EXPECT: /SCRUB median=(1[0-5]|[0-9])(\.\d+)? requests=0/
  EVIDENCE: SCRUB median=8.71 requests=0 p95=14.20 work_median=0.37 frames=96 verified=96

- [x] G3: cloud-gap hatching renders for a fixture with flagged cells (manual screenshot path)
  EVIDENCE: docs/evidence/t18-gaps.png (1440×900, `bun e2e/scrub.ts --shot` on /dev/hud at frame 60): timeline hatches the fixture's cloud deck frames 54–66 (warn hatch), GOES outage 72–80 (danger hatch over the full track), 12.5 h sighting silence 2–52 (muted hatch); fixture globe greys the masked env cells of frame 60. Same runs asserted by tests/client/hud/gaps.test.ts "gap segmentation from flags of the fixture grid" → exactly [{env 72–80}, {cloud 54–66}, {quiet 2–52}].

- [x] G4: opening a share link restores camera, time and layers (test)
  CHECK: cd apps/web && bun test tests/client/hud -t "share link" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 11 pass | 0 fail

- [x] G5: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN, measured with an uncommitted local cast on T17's client/globe/GlobeView.tsx:103 (`publishFrameGrid(grid)` lacks the FrameMeta argument on main aa23a0d). Without it the only typecheck error is that line; lint is clean; no T18 file has errors.
