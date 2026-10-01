# Place search and nearby boat access (GE6)

Two features, both off the map by default (novice rule, memory `novice-sightings-focus`):

- **Search** in the stage's bottom bar (`client/hud/search/PlaceSearch.tsx`): type a place, pick one, the globe flies there.
- **Boat ramps and marinas nearby** in the sighting card (`client/hud/search/NearbyAccess.tsx`): one button; pressed, it lists marinas and boat ramps within 10 km of the sighting, nearest first, each with an "Open in Google Maps" link (new tab), so a removal crew can plan how to reach the water.

Logic: `shared/places.ts` (request builders, parsers, distances; pure), `client/places/search.ts` (debounce, abort, cache, request cap, modes), `client/places/budget.ts` (the cap), `client/places/browser.ts` (key, origins), `client/places/fly.ts` (VIEW write). Tests: `tests/shared/places.test.ts`, `tests/client/places/search.test.ts`, `tests/client/hud/search/nearby-access.test.tsx`, over the recorded shapes in `tests/fixtures/places/`. End to end: `bun run e2e:places` against a local stub (below).

The user enabled Map Tiles, Geocoding and Places (New) on one browser key with a website (HTTP referrer) restriction. The app reads it as GE3 does (`client/keys.ts`: localStorage `inversa:keys:google-maps`, then `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`). It travels in the `X-Goog-Api-Key` request header, never in a URL.

## Which endpoint answers a browser (G1)

Keyless preflights, 2026-10-01, `Origin: http://localhost:3050` (no key anywhere):

```
$ curl -i -X OPTIONS https://maps.googleapis.com/maps/api/geocode/json -H "Origin: http://localhost:3050" \
    -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: content-type,x-goog-api-key,x-goog-fieldmask"
HTTP/2 400
content-type: application/json; charset=UTF-8
access-control-allow-origin: *

$ curl -i "https://maps.googleapis.com/maps/api/geocode/json?address=Flamingo" -H "Origin: http://localhost:3050"
HTTP/2 200
access-control-allow-origin: *
   "error_message" : "You must use an API key to authenticate each request to Google Maps Platform APIs. ...",
   "status" : "REQUEST_DENIED"

$ curl -i -X OPTIONS https://places.googleapis.com/v1/places:searchText  (same headers, method POST)
HTTP/2 200
access-control-allow-origin: http://localhost:3050
vary: origin, referer, x-origin
access-control-allow-methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
access-control-allow-headers: content-type,x-goog-api-key,x-goog-fieldmask
access-control-max-age: 3600

$ curl -i -X OPTIONS https://places.googleapis.com/v1/places:searchNearby  (same)
HTTP/2 200   (same allow-origin / allow-methods / allow-headers as searchText)

$ curl -i -X POST https://places.googleapis.com/v1/places:searchText -H "Origin: http://localhost:3050" \
    -H "content-type: application/json" -H "X-Goog-FieldMask: places.id" -d '{"textQuery":"Flamingo"}'
HTTP/2 403
access-control-allow-origin: http://localhost:3050
    "message": "Method doesn't allow unregistered callers (callers without established identity). Please use API Key ...",
    "status": "PERMISSION_DENIED"
```

| Endpoint | CORS for a browser | Referrer-restricted key | Used |
|---|---|---|---|
| Geocoding `maps.googleapis.com/maps/api/geocode/json` | A simple GET gets `access-control-allow-origin: *`; the preflight (needed for custom headers) answers 400 with no allow-headers, so the key must go in the URL | **No.** The web service answers `REQUEST_DENIED` "API keys with referer restrictions cannot be used with this API" (reproduced in bilawalsidhu/gods-eye-view issue #363). Google: web services take the *IP addresses* restriction | No |
| Places (New) Text Search `places.googleapis.com/v1/places:searchText` | Yes: the preflight echoes the origin and allows `x-goog-api-key` and `x-goog-fieldmask`; errors also carry CORS headers | Yes: Google's security guide puts "calling recent Google Maps Platform services directly over the HTTPS REST API" under the *Websites* restriction; responses `vary: referer`, and the page sends its origin as `Referer` (`Referrer-Policy: strict-origin-when-cross-origin`) | Search box, and the ramp query |
| Places (New) Nearby Search `places.googleapis.com/v1/places:searchNearby` | Yes (same headers) | Yes (same) | Marinas near a sighting |

So, as the gate allows: Geocoding does not take the user's referrer-restricted key, and **the search box uses Places (New) Text Search**. Not verified here with the real key (the agent never sees it); the e2e proves the call shape against a stub.

Sources: https://developers.google.com/maps/api-security-best-practices (application restriction by API type), https://github.com/bilawalsidhu/gods-eye-view/issues/363 (Geocoding refuses referrer-restricted keys), https://developers.google.com/maps/documentation/places/web-service/text-search, https://developers.google.com/maps/documentation/places/web-service/nearby-search.

### Requests we send

Text Search (search box), `client` → `POST https://places.googleapis.com/v1/places:searchText`:

```
X-Goog-Api-Key: <browser key>
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,places.viewport
{"textQuery":"Flamingo","languageCode":"en","pageSize":8,
 "locationBias":{"rectangle":{"low":{"latitude":S,"longitude":W},"high":{"latitude":N,"longitude":E}}}}
```

The rectangle is the active app's box (`appBBox`: South Florida for python, the four lionfish areas, the carp region). Bias, not restriction, so a well-known place outside still comes up. `languageCode` is the browser's primary language subtag (`en-US` → `en`). Field mask: `places.id` is Essentials (IDs Only); the other four are Text Search **Pro**; nothing from Enterprise (rating, hours, phone) or Atmosphere. Response used: `places[].id`, `displayName.text`, `formattedAddress`, `location.{latitude,longitude}`, `viewport.{low,high}` (optional: a point place has none; an area is framed whole).

Nearby (sighting card), two requests:

```
POST /v1/places:searchNearby
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,places.types
{"includedTypes":["marina"],"maxResultCount":20,"rankPreference":"DISTANCE","languageCode":"en",
 "locationRestriction":{"circle":{"center":{"latitude":LAT,"longitude":LON},"radius":10000}}}

POST /v1/places:searchText   (same field mask)
{"textQuery":"boat ramp","languageCode":"en","pageSize":20,
 "locationRestriction":{"rectangle":<the box around the 10 km circle>}}
```

Place types, from https://developers.google.com/maps/documentation/places/web-service/place-types (Table A, checked 2026-10-01): `marina` exists (Entertainment and Recreation); there is **no** `boat_ramp`, `boat_launch` or `boat_rental` type (the page source contains no `boat` type at all; nearby water types are `fishing_pier`, `fishing_charter`, `fishing_pond`, `ferry_terminal`, `ferry_service`). Nearby Search only filters on Table A types, so marinas come from `includedTypes: ["marina"]` and ramps and launches from a Text Search for "boat ramp" restricted to the same area. Text Search's `locationRestriction` only takes a rectangle, so the results are cut to the 10 km circle afterwards; the two lists are merged by place id and sorted by great-circle distance from the sighting. A place is labelled "Marina" when its `types` has `marina`, else "Boat ramp".

"Open in Google Maps" is a Maps URL built from the place id: `https://www.google.com/maps/search/?api=1&query=<name>&query_place_id=<id>` (https://developers.google.com/maps/documentation/urls/get-started), rendered through `ExternalLink` (`target=_blank`, `rel="noopener noreferrer"`).

### Keyless: local names and Photon

Without a key the box searches the local gazetteer (`client/voice/gazetteer.ts`, the client's South Florida list, filtered to the app's box) and Photon, and says **"Search is limited without a Google key"**.

Photon (`https://photon.komoot.io/api/?q=..&limit=8&lang=en&bbox=W,S,E,N`): a simple GET, and its responses carry `Access-Control-Allow-Origin: *` (its preflight answers `Access-Control-Allow-Methods: GET`), so the browser can call it with no proxy. Terms (https://github.com/komoot/photon README, "Demo server"): use is welcome "as long as the number of requests stay in a reasonable limit. Extensive usage will be throttled or completely banned", with no availability guarantee. We keep usage low: 300 ms debounce, at least two characters, the 10-minute memory cache, one request per settled query. Its data is OpenStreetMap (ODbL), so its results carry "Search by Photon · © OpenStreetMap contributors" linking https://www.openstreetmap.org/copyright.

The server gazetteer (`server/agent/tools/gazetteer.ts`, with the lionfish reefs) is not imported into the browser: `"use client"` modules may not reach `server/` (`inversa/use-client-purity`). See CONTRACT-REQUEST in the GE6 report.

## Display and caching terms (G5)

Read 2026-10-01:

- **Service Specific Terms**, https://cloud.google.com/maps-platform/terms/maps-service-terms, section 14 "Places API (Legacy and New)": 14.1 "Customer may use Google Maps Content from the Places API in Customer Applications without a corresponding Google Map." 14.2 "Customer must not use Google Maps Content from the Places API in conjunction with a non-Google map." 14.3 "Customer may temporarily cache latitude and longitude values from the Places API for up to 30 consecutive calendar days". Section 6 (Geocoding) has the same 6.1 and 6.2.
- **Places API (New) policies**, https://developers.google.com/maps/documentation/places/web-service/policies: show the "Google Maps" attribution when results are shown without a Google map, in Roboto (or any sans-serif), normal, weight 400, white, #1F1F1F or #5E5E5E, 12 to 16 sp, and "Don't localize Google Maps into another language"; show third-party attributions a result carries; "The place ID ... is exempt from the caching restrictions. You can therefore store place ID values indefinitely."; no pre-fetching, caching or storing of other content.
- **Cesium**, https://cesium.com/learn/cesiumjs/ref-doc/global.html (`createGooglePhotorealistic3DTileset`): `onlyUsingWithGoogleGeocoder`, "Confirmation that this tileset will only be used with the Google geocoder", which `client/globe/imagery.ts` (GE3) passes as true.

What is implemented:

- **Credit.** Under every list of Google results (search popover and the nearby list): `<span class="google" translate="no" lang="en">Google Maps</span>`, `font: 400 12px Roboto, "Helvetica Neue", Arial, sans-serif`, `color: #ffffff` in the dark and tactical themes and `#5e5e5e` in light (`client/hud/search/Credit.tsx`). Photon results carry the OpenStreetMap credit instead.
- **Google map only.** Google search runs only while the Google map is in use: a Google key is set and the Google 3D monthly cap (GE3) is not reached, so the direct Photorealistic 3D route is live. If that cap is reached the globe falls back to non-Google imagery, and search drops to the local list plus Photon and the nearby button says Google places are off until the cap resets (14.2). The other way round, with Google's tiles loaded "only with the Google geocoder", Photon is never mixed into a Google search; at the session cap the box shows local names only.
- **Nothing on the map.** Results are a list; nothing is drawn on the globe. Choosing a search result moves the camera (a VIEW write); the nearby list is text in the card, with distances.
- **Caching.** Nothing from Google is persisted: no localStorage, IndexedDB or Cache API. An in-memory map (`TtlCache`, 10 minutes, at most 100 entries, gone on reload) answers the same query again without a request. That is within 14.3 for coordinates (30 days), and it holds names and addresses only while the user is still looking at the same search. The flight target (latitude, longitude) lives in VIEW and the share link like any camera position. Place ids are kept only inside the Maps links on screen (allowed indefinitely). The Developer panel stores only the cap and this tab's request count.
- **Field masks** ask for nothing that is not shown (above).

## Cost guard

Each browser tab may send at most **200** Places requests (search and nearby together; a nearby lookup is two). The count is in sessionStorage `inversa:places-requests` (a reload keeps it, a new tab starts at zero); the cap is in localStorage `inversa:places-cap`, 1 to 10,000, edited as "Search cap" in the Developer panel's Google Maps row next to the Google 3D monthly cap and saved with SAVE KEYS. At the cap the search box shows local names with "Google search limit for this session reached …" and the nearby button says the same; nothing is sent. Typing is debounced (300 ms), a newer query aborts the older request, and a repeated query within 10 minutes is answered from memory. Prices: https://developers.google.com/maps/billing-and-pricing/pricing (Text Search Pro and Nearby Search Pro SKUs; check before enabling billing; not verified here).

## Testing without the network or a key

- Unit tests drive `createPlaceSearch` and `loadAccess` with a recording `fetch` over `tests/fixtures/places/*.json` (the documented response shapes) and a placeholder string for the key.
- `bun run e2e:places` runs the real stack (Axum over the python fixtures, the production e2e build) and a local Bun stub that speaks the documented Places (New) and Photon shapes and answers CORS like places.googleapis.com. The page reaches the stub through an origin override that only development and e2e builds read (`NODE_ENV !== "production"` or `NEXT_PUBLIC_INVERSA_E2E=1`): `NEXT_PUBLIC_PLACES_BASE_URL` at build time, or localStorage `inversa:places-base` (the e2e sets this one, because the e2e build is shared with the other scripts). A production build always calls the real hosts. The browser context aborts every request to a host other than 127.0.0.1, so nothing reaches Google or komoot.
- `e2e/a11y.ts` walks the Search popover by keyboard in each app with the real services aborted.
