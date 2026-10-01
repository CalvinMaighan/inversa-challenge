# Gates: GE8 better zoom (see docs/GODS_EYE.md; reference: gods-eye-view src/camera.js, cameraGroundGuard.js, cameraVerbs.js for ideas only)

Scope: zooming should feel good and make sense to a novice: visible controls, a log-scale altitude slider with plain place-scale labels, smooth animated steps, sensible limits (never underground, never a blurry close-up of flat imagery), and a way back. Own only new files under `client/globe/zoom/**`, `client/hud/zoom/**`, `e2e/zoom.ts`, and append-only lines in `client/globe/viewer.ts` (controller settings), `client/hud/index.tsx` (mount) and `package.json` (`e2e:zoom`). Leaf GE7 owns `client/globe/fit.ts` and the stage framing: do not edit those. Real user keys are in Doppler for live checks: Google 3D tiles and Cesium ion are available to the dev stack; never print or screenshot key values.

- [ ] G1: zoom model unit tests named `zoom model`: log-scale slider <-> altitude mapping (round trip within 1 percent), step in/out factors (default x0.5 and x2 per press), clamp to [min, max] altitude, place-scale labels (World, Country, State or region, County, City, Neighbourhood, Street) at stated thresholds, formatted readout ("12 km", "850 m"), touch pinch scale -> altitude ratio
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "zoom model" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: controls on the stage: `+` and `-` buttons, a vertical slider (role=slider, aria-valuetext "City, 12 km up"), the altitude readout, a Reset view button (back to the app's region at its default altitude), and a "Fit sightings" button that frames the currently visible sightings; all keyboard operable (`+`, `-`, arrows on the slider, Home resets), icon-only with names, placed so they never overlap the chat card, the right card or the bottom bar at 1440x900 and 1024x768
  CHECK: cd apps/web && bun run e2e:zoom 2>&1 | grep "ZOOM controls"
  EXPECT: /ZOOM controls buttons=ok slider=ok keys=ok reset=ok fit=ok overlap=0/
  EVIDENCE: pending

- [ ] G3: motion: a button press or key animates the camera in about 300 to 400 ms with easing and the altitude ends within 3 percent of the target; scroll wheel zoom is tuned (one wheel notch changes altitude by about 15 to 25 percent, smooth, no jump at any altitude); double click zooms in on the clicked point (the point stays under the cursor within 20 px); measured by the e2e from the camera's real altitude. Prints `ZOOM motion step_ms=<n> end_err_pct=<n> wheel_pct=<n> dblclick_px=<n>` with step_ms in 250..500, end_err_pct <= 3, wheel_pct 10..30, dblclick_px <= 20
  CHECK: cd apps/web && bun run e2e:zoom 2>&1 | grep "ZOOM motion"
  EXPECT: /ZOOM motion step_ms=([2-4]\d\d|500) end_err_pct=[0-3](\.\d+)? wheel_pct=(1\d|2\d|30)(\.\d+)? dblclick_px=(\d|1\d|20)(\.\d+)?/
  EVIDENCE: pending

- [ ] G4: limits and ground guard: the camera cannot go below the terrain or the 3D tiles (collision on, minimum height above ground 30 m with 3D tiles and about 400 m on flat imagery so imagery is never stretched into mush), the maximum altitude frames the whole planet, and the limits follow the active imagery route (`data-imagery-route` from the ladder). Prints `ZOOM limits min_3d_m=<n> min_flat_m=<n> max_km=<n> underground=0`
  CHECK: cd apps/web && bun run e2e:zoom 2>&1 | grep "ZOOM limits"
  EXPECT: /ZOOM limits min_3d_m=\d+ min_flat_m=\d+ max_km=\d+ underground=0/
  EVIDENCE: pending

- [ ] G5: when Google 3D is active (the user's Google key and the 3D zone), zooming below about 5 km tilts the view obliquely so buildings read as 3D, and a small "3D city view" hint shows once per session at the threshold; with only flat imagery the view stays top down and the hint says nothing misleading. Verified live on the dev stack with the real keys once (screenshot), and by a unit test with a stubbed route for CI. Prints `ZOOM tilt route=<route> tilt_deg=<n> hint=<0|1>`
  CHECK: cd apps/web && bun run e2e:zoom 2>&1 | grep "ZOOM tilt"
  EXPECT: /ZOOM tilt route=\S+ tilt_deg=\d+ hint=[01]/
  EVIDENCE: pending

- [ ] G6: the zoom state is in the share link (`alt` quantised) so a reopened link lands at the same zoom, and the agent's `set_view` still works against the new limits (existing share-link and agent view tests pass)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "share link" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G7: touch: pinch and two-finger drag work (unit-level gesture math tested; the Cesium touch controller settings are set), and at 375x812 the controls collapse to the +/- pair without covering the dock; a11y 0 serious 0 critical with the controls on screen; idle governor stays idle (no extra frames while the camera rests)
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE (app=\w+ )?serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G8: web unit suite, typecheck, lint, build clean; screenshots at 1440x900 (city view with 3D tiles if the key works, region view, controls close-up) saved to docs/evidence/ and viewed, one observation each
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
