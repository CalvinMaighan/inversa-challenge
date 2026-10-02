# Gates: T17 Cesium globe + layers (opus)

Scope: `apps/web/client/globe/**`:
- CesiumJS assets are copied to `public/cesium` by a script, with `CESIUM_BASE_URL` set. The viewer is client-only and its widgets are hidden.
- An imagery ladder (after God's Eye View `src/maps/imagery.js`): ion Google 3D over Miami/Keys and Bing elsewhere when `NEXT_PUBLIC_CESIUM_ION_TOKEN` is set, otherwise keyless Esri/OSM. A quota counter triggers automatic fallback.
- A layer contract `init/enable/disable/update(frame)/stats`, with layers for sightings (PointPrimitiveCollection + billboards), hotspot heatmap (canvas texture from SAB grid), LST/SST raster, stations, alerts, missions and peer cursors. Primitives only.
- A render governor using requestRenderMode.
- The Cesium clock is bound to the TIME key.

- [x] G1: globe tests pass (layer contract, imagery ladder selection, quota fallback, heatmap color ramp)
  CHECK: cd apps/web && bun test tests/client/globe 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 78 pass | 0 fail

- [x] G2: the production build includes Cesium assets under public/cesium
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && ls public/cesium/Workers | head -1
  EXPECT: /\.js$/m
  EVIDENCE: chunk-2X5O55FT.js

- [x] G3: the keyless globe renders under COOP/COEP with no CORP/COEP console errors (manual: the in-app browser against `next start`; quote the console summary and `crossOriginIsolated`)
  EVIDENCE: after the C16 frame-contract rework, on main 06f034b plus this branch: `bun run e2e:globe` (production build, standalone `next start`, headless Chromium on /dev/globe) printed `GLOBE coi=true isolation_errors=0 imagery=esri tiles=37 workers=33 cesium=1 console_errors=3 (api_5xx=3)`. The 3 console errors are `POST /v1/graphql 500`, because no Axum runs behind the proxy (INVERSA_API_ORIGIN points at a dead port). Screenshot: docs/evidence/t17-globe.png (Esri imagery over South Florida). The in-app browser run before the rework showed the same: `crossOriginIsolated: true`, 38 Esri tiles 200, /cesium/index.js and 36 worker files 200, 0 COEP/CORP messages.

- [x] G4: idle render is paused: requestRenderMode is true and no frames render over 5 s idle (manual, or a Playwright script printing `IDLE-FRAMES 0`)
  EVIDENCE: the same `bun run e2e:globe` run counted scene.postRender through GlobeApi.onPostRender for 5 s after a 4 s settle and printed `IDLE-FRAMES 0 raf=300 requestRenderMode=true governor=idle`. raf=300 animation frames prove the page was live (60 fps) while nothing rendered. Earlier, in the in-app browser, a VIEW seq bump flew to Key West, the flight rendered, and the next 5 s showed `IDLE-FRAMES 0` with no holds.

- [x] G5: no Entity API use in layers (primitives only)
  CHECK: grep -rn "viewer.entities\|new Entity(" apps/web/client/globe | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G6: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [ ] G7: (live, blocked on H7) the ion imagery ladder loads Google 3D over Miami (screenshot path)
  EVIDENCE: pending

ABANDON: G7 blocked on H7: no CESIUM_ION_TOKEN is provisioned, so the ion rung (World Terrain, Bing via ion, Google 3D asset 2275207 over Miami/Keys below 30 km) cannot be screenshotted live. The rung is implemented in client/globe/imagery.ts and its selection, zone gating and quota fallback are unit-tested (tests/client/globe/ladder.test.ts, quota.test.ts); the keyless rung is verified live under G3.
