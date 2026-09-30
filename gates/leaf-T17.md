# Gates: T17 Cesium globe + layers (opus)

Scope: `apps/web/client/globe/**`:
- CesiumJS assets are copied to `public/cesium` by a script, with `CESIUM_BASE_URL` set. The viewer is client-only and its widgets are hidden.
- An imagery ladder (after God's Eye View `src/maps/imagery.js`): ion Google 3D over Miami/Keys and Bing elsewhere when `NEXT_PUBLIC_CESIUM_ION_TOKEN` is set, otherwise keyless Esri/OSM. A quota counter triggers automatic fallback.
- A layer contract `init/enable/disable/update(frame)/stats`, with layers for sightings (PointPrimitiveCollection + billboards), hotspot heatmap (canvas texture from SAB grid), LST/SST raster, stations, alerts, missions and peer cursors. Primitives only.
- A render governor using requestRenderMode.
- The Cesium clock is bound to the TIME key.

- [ ] G1: globe tests pass (layer contract, imagery ladder selection, quota fallback, heatmap color ramp)
  CHECK: cd apps/web && bun test tests/client/globe 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: pending

- [ ] G2: the production build includes Cesium assets under public/cesium
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && ls public/cesium/Workers | head -1
  EXPECT: /\.js$/
  EVIDENCE: pending

- [ ] G3: the keyless globe renders under COOP/COEP with no CORP/COEP console errors (manual: the in-app browser against `next start`; quote the console summary and `crossOriginIsolated`)
  EVIDENCE: pending

- [ ] G4: idle render is paused: requestRenderMode is true and no frames render over 5 s idle (manual, or a Playwright script printing `IDLE-FRAMES 0`)
  EVIDENCE: pending

- [ ] G5: no Entity API use in layers (primitives only)
  CHECK: grep -rn "viewer.entities\|new Entity(" apps/web/client/globe | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: pending

- [ ] G6: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: pending

- [ ] G7 (live, blocked on H7): the ion imagery ladder loads Google 3D over Miami (screenshot path)
  EVIDENCE: pending
