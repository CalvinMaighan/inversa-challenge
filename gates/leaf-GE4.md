# Gates: GE4 vessels (AIS) with timeline playback, carp and lionfish apps (see docs/GODS_EYE.md GC4)

Scope: Axum AISStream websocket client per app (carp: Louisiana coast; lionfish: Florida Keys, Belize, Mexican Caribbean, Colombia, from the app's region boxes), stored as time series in each app's observations.db; GraphQL `vessels`; evidence `vessel:<mmsi>`; a `vessels` globe layer showing the ship icons and fading trails that move as the timeline plays. Key `AISSTREAM_API_KEY` from env, server only, never logged. No key: source reports `disabled: AISSTREAM_API_KEY not set` in feed state; stored history still replays. Tests use a local mock websocket and recorded real frames in fixtures, never the network.

- [ ] G1: parser unit tests named `ais parse` on recorded real AISStream frames (position report, ship static data, malformed, error envelope) in `api/tests/fixtures/ais/`: correct mmsi, lat, lon, sog, cog, name, ship type; bad frames are counted, not fatal
  CHECK: cargo test --manifest-path api/Cargo.toml ais_parse 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending

- [ ] G2: watchdog tests named `ais watchdog`: auth rejection stops retries, rate limit honours Retry-After, transport errors back off, a quiet socket is recycled; no busy loop
  CHECK: cargo test --manifest-path api/Cargo.toml ais_watchdog 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9]/
  EVIDENCE: pending

- [ ] G3: storage and query: positions are written through the writer thread in batches, thinned to at most one per vessel per minute, kept for 30 days; GraphQL `vessels(bbox, from, to, types, limit)` returns tracks ordered by time, respects bbox and window; `schema_matches_contract` passes with the updated `api/schema.graphql`
  CHECK: cargo test --manifest-path api/Cargo.toml vessels 2>&1 | grep "test result" && cargo test --manifest-path api/Cargo.toml schema_matches_contract 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9][\s\S]*test result: ok\. 1 passed/
  EVIDENCE: pending

- [ ] G4: end to end on a mock AIS websocket: `bun run e2e:vessels` starts the stack with the mock, shows vessels on the carp app, plays the timeline across the stored window and prints `VESSELS shown=<n> moved=<n> window_h=<h> trails=<n>` with moved > 0 (positions of at least one vessel differ between two timeline times)
  CHECK: cd apps/web && bun run e2e:vessels 2>&1 | grep "VESSELS shown"
  EXPECT: /VESSELS shown=([1-9]\d*) moved=([1-9]\d*) window_h=\d+ trails=([1-9]\d*)/
  EVIDENCE: pending

- [ ] G5: with a real `AISSTREAM_API_KEY` set in the environment (Doppler `inversa/dev` once the user adds it; otherwise ABANDON this gate with that reason) the live socket delivers positions for the carp box within 2 minutes: `AISLIVE app=carp positions=<n>`
  CHECK: cd api && doppler run --project inversa --config dev -- cargo test --release ais_live -- --ignored --nocapture 2>&1 | grep AISLIVE
  EXPECT: /AISLIVE app=carp positions=([1-9]\d*)/
  EVIDENCE: pending

- [ ] G6: layer: default off; in the Layers popover under Ships for carp and lionfish only (python hidden); icons by vessel type; click opens an evidence card with name, type, speed, course and an Open at link to the MarineTraffic or VesselFinder page by MMSI (`target=_blank`); layer unit tests named `vessels layer`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "vessels layer" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G7: api suite, clippy, web unit, typecheck, lint clean
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -c "test result: ok" && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1 && bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /Finished[\s\S]*^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G8: AISStream terms and attribution recorded in docs (free beta, AIS is a public broadcast, per the reference's DATA_SOURCES.md; verify on aisstream.io) and the attribution line shows "Vessel positions: AISStream.io" when the layer is on. Quote the lines
  EVIDENCE: pending
