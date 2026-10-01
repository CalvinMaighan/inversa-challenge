# Gates: GE6 place search and nearby boat ramps (Google Geocoding and Places API (New), docs/GODS_EYE.md)

Scope: a search item in the stage's bottom bar (GE1 `BottomBar.tsx` `ITEMS`) that finds a place and flies the globe there; and on a selected sighting a "Boat ramps and marinas nearby" action listing Places (New) results with distance, and links that open Google Maps in a new tab, so removal crews can plan access. The user has enabled Map Tiles, Geocoding and Places (New) on the one browser key (referrer restricted); you never see that key and enter none. Tests use recorded fixtures of the documented response shapes and a local stub server, never the network and never a key.

- [ ] G1: CORS and call-shape facts verified from Google's documentation and a keyless preflight (`curl -i -X OPTIONS` with Origin and the request headers, no key) for each endpoint you call from the browser (Geocoding `maps.googleapis.com/maps/api/geocode/json`, Places (New) `places.googleapis.com/v1/places:searchText` and `:searchNearby`). Record in docs/places.md which endpoint answers CORS for a browser, the documented request/response and the field mask you use, and cite URLs. If Geocoding does not answer CORS, use Places (New) searchText for the search box and say so
  EVIDENCE: pending

- [ ] G2: unit tests named `place search` cover: request building (field mask minimal, region bias to the app's bbox, language), response parsing from fixtures (results with and without a viewport), debounce and abort of stale requests, per-session request cap (default 200, editable alongside the Google cap in the Developer panel), result cache (same query within 10 min makes no second request), no key means the box searches only the local gazetteer and Photon (keyless, check its CORS and terms) and says "Search is limited without a Google key"
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "place search" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: unit tests named `nearby access` cover: Nearby request for types boat ramp, marina and boat launch style places within 10 km (choose the real Places type names from the documentation, cite them), results sorted by distance from the sighting, parsing from a fixture, "Open in Google Maps" link built from the place id (https, `target=_blank`, `rel="noopener noreferrer"` via `ExternalLink`), empty result says "No boat ramps found within 10 km"
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "nearby access" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G4: e2e against a local stub of the Google endpoints (env override of the base URL, dev and test only) prints `PLACES search_results=<n> flew=1 nearby=<n> links_new_tab=<n> no_key_message=1`, with the globe camera moved to the chosen place (distance under 5 km), and the nearby list shown in the right sighting card
  CHECK: cd apps/web && bun run e2e:places 2>&1 | grep "PLACES search_results"
  EXPECT: /PLACES search_results=([1-9]\d*) flew=1 nearby=([1-9]\d*) links_new_tab=([1-9]\d*) no_key_message=1/
  EVIDENCE: pending

- [ ] G5: Google's display requirements for Places and Geocoding results (attribution, no caching beyond what the terms allow, no storing place ids long term except as allowed) are read from the current terms, summarised in docs/places.md with URLs, and implemented (for example a "Google Maps" credit near results). Quote what you implemented
  EVIDENCE: pending

- [ ] G6: a11y: the search popover is keyboard operable (combobox pattern, arrows, Enter, Escape returns focus), axe 0 serious and 0 critical with it open; novice rule holds (nothing new on the map by default; the nearby list appears only when the user asks)
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE serious=0 critical=0[\s\S]*KEYBOARD-OK/
  EVIDENCE: pending

- [ ] G7: web unit suite, typecheck, lint clean; no key-shaped string in `git diff` (`AIza`, `sk-`, `eyJ`)
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && git diff pivot/three-apps...HEAD | grep -cE "AIza[0-9A-Za-z_-]{20}|sk-[0-9A-Za-z]{20}|eyJ[0-9A-Za-z_-]{20}" | grep -x 0 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G8: screenshots (search open with results, nearby list in the sighting card) saved to docs/evidence/ and viewed; quote one observation each
  EVIDENCE: pending
