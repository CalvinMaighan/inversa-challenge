# Gates: GE5 water temperature and weather overlays (see docs/GODS_EYE.md GC5)

Scope: layers `sst-map` (NASA GIBS sea-surface temperature), `radar` (NOAA nowCOAST MRMS), `clouds` (GOES IR via nowCOAST), `lightning` (nowCOAST density), `cyclones` (NHC advisories). All raster tiles through the same-origin Axum overlay proxy with a fixed upstream allowlist and media.rs-grade SSRF rules; all follow the timeline (time parameter snaps to the layer's real cadence and the layer says which time it shows). Verify each upstream's current endpoint and layer name by fetching its capabilities document, and cite the URL in the evidence. Layers default off; grouped under "Water and weather" in Layers; carp and lionfish only for `sst-map`, all apps for the weather layers.

- [x] G1: proxy unit tests named `overlay proxy`: only allowlisted hosts and layer ids, https only, no IP literals, redirects re-checked, size and type limits, timeouts, 400 for a bad layer id, tile cache keyed by layer+time+z/x/y
  CHECK: cargo test --manifest-path api/Cargo.toml overlay_proxy 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 371 filtered out; finished in 0.43s

- [x] G2: real upstream check, one tile per layer through the running proxy: `bun run e2e:overlays` prints `OVERLAYS sst=200 radar=200 clouds=200 lightning=200 cyclones=200` with image or JSON bodies sniffed (not just status)
  CHECK: cd apps/web && bun run e2e:overlays 2>&1 | grep "OVERLAYS sst"
  EXPECT: /OVERLAYS sst=200 radar=200 clouds=200 lightning=200 cyclones=200/
  EVIDENCE: OVERLAYS sst=200 radar=200 clouds=200 lightning=200 cyclones=200 (bodies sniffed: sst-map 7265 B PNG via /v1/lionfish/overlay/sst-map/6/17/27?time=2026-09-30T00:00:00Z, radar 9006 B PNG, clouds 38450 B PNG, lightning 657 B PNG via /v1/carp/overlay/<id>/6/15/26, cyclones 93621 B JSON with 3 active storms and 52 geometry features; every answer carried cross-origin-resource-policy: same-origin). Layer names and time dimensions confirmed on 2026-10-01 from https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS&version=1.3.0&request=GetCapabilities (conus_base_reflectivity_mosaic, time nearestValue=1, ~4 min), .../satellite/ows (goes_longwave_imagery, 5 min), .../lightning_detection/ows (ldn_lightning_strike_density, 15 min), https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml (GHRSST_L4_MUR_Sea_Surface_Temperature, GoogleMapsCompatible_Level7, P1D, Default 2026-09-30), https://www.nhc.noaa.gov/CurrentStorms.json and https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer?f=json (layers 5/6/7/11, geoJSON); licences in docs/overlays.md.

- [x] G3: timeline: unit tests named `overlay time` snap an arbitrary timeline time to each layer's cadence (GIBS daily, radar about 4 min, clouds about 5 min, lightning 15 min), clamp to the available range and report the shown time; e2e prints `OVERLAY-TIME radar_steps=<n> shown_changes=<n>` while playing 30 minutes of timeline with shown_changes greater than 1
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "overlay time" 2>&1 | grep -E "pass|fail" && bun run e2e:overlays 2>&1 | grep "OVERLAY-TIME"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*OVERLAY-TIME radar_steps=([1-9]\d*) shown_changes=([2-9]|[1-9]\d+)/
  EVIDENCE: 0 fail | OVERLAY-TIME radar_steps=4 shown_changes=2

- [x] G4: cyclones: parsed storm positions, cone and track render as globe entities when a storm exists; with none active the layer says "No active storms" instead of an empty toggle; fixture test named `nhc cyclones` uses a recorded CurrentStorms.json
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "nhc cyclones" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 5 pass | 0 fail

- [x] G5: layers popover shows the group, a one-line plain-words description each ("Where it is raining now"), legend with units for SST (degrees C and F), opacity slider, attribution lines per source in the credit line when on; novice default unchanged (all off)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "water and weather" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 4 pass | 0 fail

- [x] G6: api suite, clippy, web unit, typecheck, lint, links e2e clean
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /Finished[\s\S]*^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 0 fail | CLEAN (cargo test 375 passed 0 failed 5 ignored; clippy -D warnings Finished; web 1052 pass 0 fail across 136 files; tsc and eslint clean. The links e2e opens the Layers section with every overlay off, so it meets no overlay anchor; the new attribution anchors are ExternalLink and tests/client/hud/legend/water-weather.test.tsx asserts target=_blank and rel noopener noreferrer on each.)

- [x] G7: screenshots (SST over the Keys, radar over Louisiana if raining or noted if clear, clouds) saved to docs/evidence/ and viewed
  EVIDENCE: docs/evidence/ge5-sst-keys.png (lionfish, MUR SST red at about 29-30 C over the Keys and the Gulf, legend "Showing 2026-09-30 (newest available)", credit line "NASA GIBS (MUR SST)"), docs/evidence/ge5-radar-louisiana.png (carp, radar and lightning on; it was raining: RADAR-ECHO louisiana_tile_pixels=5519 non-transparent pixels in the z6 15/26 tile, rain cells over the Atchafalaya sites, "Showing 20:12 UTC, 2026-10-01 (newest available)"), docs/evidence/ge5-clouds.png (carp, GOES infrared over the Gulf, "Showing 20:15 UTC"), docs/evidence/ge5-cyclones.png (lionfish, Hurricane Rachel with forecast cone and dashed forecast track, Tropical depression Nineteen-E, Tropical storm Nolo, past tracks, "3 active storms", credit "NOAA/NWS NHC and CPHC"); all four viewed by the leaf on 2026-10-01, 1440x900, taken by apps/web/e2e/overlays.ts with the Water and weather group open.
