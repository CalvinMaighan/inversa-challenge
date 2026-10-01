# Gates: GE6 place search and nearby boat ramps (Google Geocoding and Places API (New), docs/GODS_EYE.md)

Scope: a search item in the stage's bottom bar (GE1 `BottomBar.tsx` `ITEMS`) that finds a place and flies the globe there; and on a selected sighting a "Boat ramps and marinas nearby" action listing Places (New) results with distance, and links that open Google Maps in a new tab, so removal crews can plan access. The user has enabled Map Tiles, Geocoding and Places (New) on the one browser key (referrer restricted); you never see that key and enter none. Tests use recorded fixtures of the documented response shapes and a local stub server, never the network and never a key.

- [x] G1: CORS and call-shape facts verified from Google's documentation and a keyless preflight (`curl -i -X OPTIONS` with Origin and the request headers, no key) for each endpoint you call from the browser (Geocoding `maps.googleapis.com/maps/api/geocode/json`, Places (New) `places.googleapis.com/v1/places:searchText` and `:searchNearby`). Record in docs/places.md which endpoint answers CORS for a browser, the documented request/response and the field mask you use, and cite URLs. If Geocoding does not answer CORS, use Places (New) searchText for the search box and say so
  EVIDENCE: keyless preflights 2026-10-01 (docs/places.md "Which endpoint answers a browser"): Geocoding OPTIONS `HTTP/2 400` with only `access-control-allow-origin: *` (no allow-headers), a simple GET `HTTP/2 200` `access-control-allow-origin: *` + `REQUEST_DENIED`; places:searchText and places:searchNearby OPTIONS `HTTP/2 200`, `access-control-allow-origin: http://localhost:3050`, `access-control-allow-headers: content-type,x-goog-api-key,x-goog-fieldmask`, `vary: referer`; keyless POST `HTTP/2 403 PERMISSION_DENIED` still with CORS headers. Geocoding answers CORS but refuses referrer-restricted keys ("API keys with referer restrictions cannot be used with this API", gods-eye-view#363; Google security guide: web services take IP restrictions, "recent ... HTTPS REST" services take Websites), so the search box uses Places (New) searchText, said in docs/places.md. Field masks: search `places.id,places.displayName,places.formattedAddress,places.location,places.viewport`, access `...places.types` (Essentials + Pro only). URLs cited: text-search, nearby-search, place-types, api-security-best-practices, Maps URLs.

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

- [x] G5: Google's display requirements for Places and Geocoding results (attribution, no caching beyond what the terms allow, no storing place ids long term except as allowed) are read from the current terms, summarised in docs/places.md with URLs, and implemented (for example a "Google Maps" credit near results). Quote what you implemented
  EVIDENCE: read 2026-10-01: Service Specific Terms §14 Places (14.1 use without a Google Map allowed, 14.2 "must not use ... in conjunction with a non-Google map", 14.3 lat/lng cache ≤30 days; §6 Geocoding same), Places (New) policies ("Google Maps" text, Roboto/sans-serif 400, white/#1F1F1F/#5E5E5E, 12-16, not localized; place ID exempt from caching), Cesium `onlyUsingWithGoogleGeocoder`; summarised with URLs in docs/places.md "Display and caching terms". Implemented (client/hud/search/Credit.tsx): `<span className="google" translate="no" lang="en">Google Maps</span>` with `font: 400 12px / 1.4 Roboto, "Helvetica Neue", Arial, sans-serif; color: #ffffff` (light theme `#5e5e5e`) under every Google result list (e2e: google_credit=1, and visible in docs/evidence/places-search.png and places-nearby.png); Photon results credit "© OpenStreetMap contributors" (e2e osm_credit=1). Google search and the nearby list run only while the Google 3D map is in use (key set, GE3 cap not reached), else local+Photon / "no-map" note (tests: `a key but the Google 3D map capped ... Photon, not Places`, `... (3D cap reached): nothing is requested`). Nothing persisted from Google: only an in-memory `TtlCache` (10 min, ≤100 entries); place ids live only in the on-screen Maps links.

- [ ] G6: a11y: the search popover is keyboard operable (combobox pattern, arrows, Enter, Escape returns focus), axe 0 serious and 0 critical with it open; novice rule holds (nothing new on the map by default; the nearby list appears only when the user asks)
  CHECK: cd apps/web && bun run e2e:a11y 2>&1 | grep -E "AXE|KEYBOARD"
  EXPECT: /AXE (app=\w+ )?serious=0 critical=0[\s\S]*KEYBOARD-OK/
  NOTE: EXPECT widened by GE6 with `(app=\w+ )?`: e2e/a11y.ts has printed `AXE app=<id> serious=...` since the apps pivot, so the original `/AXE serious=0 .../` could never match its output.
  EVIDENCE: pending

- [ ] G7: web unit suite, typecheck, lint clean; no key-shaped string in `git diff` (`AIza`, `sk-`, `eyJ`)
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && git diff pivot/three-apps...HEAD | grep -cE "AIza[0-9A-Za-z_-]{20}|sk-[0-9A-Za-z]{20}|eyJ[0-9A-Za-z_-]{20}" | grep -x 0 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G8: screenshots (search open with results, nearby list in the sighting card) saved to docs/evidence/ and viewed; quote one observation each
  EVIDENCE: pending
