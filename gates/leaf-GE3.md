# Gates: GE3 developer keys panel, Google 3D direct route, local media cache (see docs/GODS_EYE.md GC3)

Scope: `shared/keys.ts` registry; `GET /api/dev/keys`; Developer panel filling GE1's `DeveloperSlot` (if GE1 is not merged yet, mount the panel behind a top-right icon button of your own and leave a note); Google Map Tiles direct route in the imagery ladder with a monthly cap; Cache API media cache. You enter no credentials anywhere; tests use dummy values.

- [x] G1: registry unit tests named `key registry`: every key in the table of docs/GODS_EYE.md exists with scope, purpose, getUrl, fallback; browser keys resolve localStorage then build env; server keys never expose a value
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "key registry" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 7 pass | 0 fail

- [x] G2: `GET /api/dev/keys` returns booleans only, and `POST /api/dev/keys` (loopback and development only, 403 otherwise) writes `data/local-keys.env` with mode 0600 without echoing values. Test sets a server key to the sentinel `SENTINEL-DO-NOT-LEAK`, calls both routes, and asserts the sentinel is absent from every response body and from captured server log output, that a non-loopback or production request gets 403, and that a key already in the environment is reported `external` and not overwritten
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "dev keys route" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 7 pass | 0 fail

- [x] G3: Developer panel e2e matches the spec in docs/GODS_EYE.md ("Power up the globe"): the top-right developer button opens the modal, one row per registry key with status dot, badges, purpose line, MANAGE or GET KEY link (new tab), paste fields only for unset keys, Esc closes and returns focus. A dummy browser key typed in persists across reload via localStorage and shows set; a dummy server key saved in dev mode lands in `data/local-keys.env` (the test uses a temp INVERSA_DATA_DIR) and the row turns set after the dev supervisor restarts. Prints `DEVPANEL rows=<n> browser_inputs=<n> server_inputs=<n> persists=1 esc=ok`
  CHECK: cd apps/web && bun run e2e:developer 2>&1 | grep DEVPANEL
  EXPECT: /DEVPANEL rows=([1-9]\d*) browser_inputs=([1-9]\d*) server_inputs=([1-9]\d*) persists=1 esc=ok/
  EVIDENCE: DEVPANEL rows=7 browser_inputs=2 server_inputs=7 persists=1 esc=ok a11y_serious=0 a11y_critical=0 restarted=1 live=page-reloaded imagery=google-direct/esri google_requests=0

- [x] G4: imagery ladder unit tests named `google direct`: a Google key selects route `google-direct` before ion, a failed direct load falls to ion, then to keyless; the monthly cap drops the direct route to the next rung at 90 percent; Louisiana (carp app) zone added; no request is made without a key
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "google direct" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 6 pass | 0 fail

- [x] G5: media cache: sighting photos load through `client/media` (Cache API, stale-while-revalidate, bounded to 200 MB with LRU eviction). Unit tests named `media cache`; the e2e opens a sighting with a photo twice and prints `MEDIA first=network second=cache img_ok=1`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "media cache" 2>&1 | grep -E "pass|fail" && bun run e2e:media 2>&1 | grep "MEDIA first"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail[\s\S]*MEDIA first=network second=cache img_ok=1/
  EVIDENCE: 0 fail | MEDIA first=network second=cache img_ok=1 second_requests=0 photo=sighting:51

- [x] G6: no secret reaches a screenshot, log or committed file: grep of the diff for key-shaped strings is empty (`AIza`, `sk-`, `eyJ`)
  CHECK: git diff main...HEAD | grep -E "AIza[0-9A-Za-z_-]{20}|sk-[0-9A-Za-z]{20}|eyJ[0-9A-Za-z_-]{20}" | wc -l
  EXPECT: /^\s*0\s*$/m
  EVIDENCE: 0

- [x] G7: unit suite, typecheck, lint, build clean; a11y 0 serious 0 critical with the panel open
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web build >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 0 fail | CLEAN

- [x] G8: docs: README env table and docs/HUMAN_STEPS.md list each key, where to get it and what it unlocks; Google billing note says to verify the current price. Quote the added lines
  EVIDENCE: README.md "### Keys" table now has columns Variable | Where | Get it | Enables | Without it, one row each for `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` ("https://developers.google.com/maps/documentation/tile/get-api-key (enable Map Tiles API, restrict by HTTP referrer)" / "Google Photorealistic 3D Tiles direct, tried before ion; capped at 1,000 sessions per browser per month"), `NEXT_PUBLIC_CESIUM_ION_TOKEN` (https://ion.cesium.com/tokens), `AISSTREAM_API_KEY` (https://aisstream.io/apikeys, "live ships"), `OPENROUTER_API_KEY` (https://openrouter.ai/settings/keys), `XAI_API_KEY` (https://console.x.ai/), GOES AWS trio (HUMAN_STEPS section 7), NWWS pair ("email `NWWS.Issue@noaa.gov`, docs/HUMAN_STEPS.md section 8"); billing line: "Google bills Map Tiles per root-tileset request after a monthly free allowance. Check the current price at https://developers.google.com/maps/billing-and-pricing/pricing before you enable billing; this README does not state it." UI table row: "| Map | Developer (key) | Top right: "Power up the globe", every API key with set or missing, where to get it and a paste field (see Keys below). |". docs/HUMAN_STEPS.md "## 14. Globe keys: Google 3D, Cesium ion, AISStream (Developer panel)": table Key | Get it | What it unlocks | Where it goes for Google Maps, Cesium ion, AISStream, and OpenRouter/xAI/AWS GOES/NWWS; "Check the current price at <https://developers.google.com/maps/billing-and-pricing/pricing> before enabling billing (the price was not verified here), and set a budget alert in Google Cloud Billing."
