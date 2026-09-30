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
  EVIDENCE: 77 pass | 0 fail

- [x] G2: the production build includes Cesium assets under public/cesium
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && ls public/cesium/Workers | head -1
  EXPECT: /\.js$/m
  EVIDENCE: chunk-2X5O55FT.js

- [x] G3: the keyless globe renders under COOP/COEP with no CORP/COEP console errors (manual: the in-app browser against `next start`; quote the console summary and `crossOriginIsolated`)
  EVIDENCE: standalone `next start` build on 127.0.0.1:3057, fresh tab on /dev/globe: `crossOriginIsolated: true`; imagery rung `esri` (plan `no-token`, 0 imagery errors), 38 Esri tile requests all 200, /cesium/index.js + 36 /cesium/Workers/* + Assets all 200; console: 4 errors, all `POST /v1/graphql 500` (no Axum running behind the proxy), 0 COEP/CORP/blocked messages. Screenshot showed Esri imagery over South Florida.

- [x] G4: idle render is paused: requestRenderMode is true and no frames render over 5 s idle (manual, or a Playwright script printing `IDLE-FRAMES 0`)
  EVIDENCE: same page, counting scene.postRender via GlobeApi.onPostRender for 5 s after load settled: `IDLE-FRAMES 0`, `requestRenderMode: true`, governor `idle`, no holds. Also after a VIEW seq bump fly to Key West (dev server): flight rendered, then `IDLE-FRAMES 0` over the next 5 s with holds [].

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
