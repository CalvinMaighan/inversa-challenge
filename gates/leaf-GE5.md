# Gates: GE5 water temperature and weather overlays (see docs/GODS_EYE.md GC5)

Scope: layers `sst-map` (NASA GIBS sea-surface temperature), `radar` (NOAA nowCOAST MRMS), `clouds` (GOES IR via nowCOAST), `lightning` (nowCOAST density), `cyclones` (NHC advisories). All raster tiles through the same-origin Axum overlay proxy with a fixed upstream allowlist and media.rs-grade SSRF rules; all follow the timeline (time parameter snaps to the layer's real cadence and the layer says which time it shows). Verify each upstream's current endpoint and layer name by fetching its capabilities document, and cite the URL in the evidence. Layers default off; grouped under "Water and weather" in Layers; carp and lionfish only for `sst-map`, all apps for the weather layers.

- [ ] G1: proxy unit tests named `overlay proxy`: only allowlisted hosts and layer ids, https only, no IP literals, redirects re-checked, size and type limits, timeouts, 400 for a bad layer id, tile cache keyed by layer+time+z/x/y
  CHECK: cargo test --manifest-path api/Cargo.toml overlay_proxy 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending

- [ ] G2: real upstream check, one tile per layer through the running proxy: `bun run e2e:overlays` prints `OVERLAYS sst=200 radar=200 clouds=200 lightning=200 cyclones=200` with image or JSON bodies sniffed (not just status)
  CHECK: cd apps/web && bun run e2e:overlays 2>&1 | grep "OVERLAYS sst"
  EXPECT: /OVERLAYS sst=200 radar=200 clouds=200 lightning=200 cyclones=200/
  EVIDENCE: pending

- [ ] G3: timeline: unit tests named `overlay time` snap an arbitrary timeline time to each layer's cadence (GIBS daily, radar about 4 min, clouds about 5 min, lightning 15 min), clamp to the available range and report the shown time; e2e prints `OVERLAY-TIME radar_steps=<n> shown_changes=<n>` while playing 30 minutes of timeline with shown_changes greater than 1
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "overlay time" 2>&1 | grep -E "pass|fail" && bun run e2e:overlays 2>&1 | grep "OVERLAY-TIME"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*OVERLAY-TIME radar_steps=([1-9]\d*) shown_changes=([2-9]|[1-9]\d+)/
  EVIDENCE: pending

- [ ] G4: cyclones: parsed storm positions, cone and track render as globe entities when a storm exists; with none active the layer says "No active storms" instead of an empty toggle; fixture test named `nhc cyclones` uses a recorded CurrentStorms.json
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "nhc cyclones" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G5: layers popover shows the group, a one-line plain-words description each ("Where it is raining now"), legend with units for SST (degrees C and F), opacity slider, attribution lines per source in the credit line when on; novice default unchanged (all off)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "water and weather" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G6: api suite, clippy, web unit, typecheck, lint, links e2e clean
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /Finished[\s\S]*^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G7: screenshots (SST over the Keys, radar over Louisiana if raining or noted if clear, clouds) saved to docs/evidence/ and viewed
  EVIDENCE: pending
