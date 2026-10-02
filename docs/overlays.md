# Water and weather overlays (GE5)

Five globe layers under "Water and weather" in the Layers popover (About → More data (for experts)), all off at
first load (docs/GODS_EYE.md GC6), each following the timeline. Raster tiles come through the Axum proxy
`GET /v1/{app}/overlay/{layer}/{z}/{x}/{y}?time=<rfc3339>` (`api/src/overlay.rs`), storms through
`GET /v1/{app}/overlay/cyclones`. The web app runs under `Cross-Origin-Embedder-Policy: require-corp`, and
nowCOAST and NHC advertise no CORS, so the proxy answers same-origin with `Cross-Origin-Resource-Policy:
same-origin`.

| Layer id | Apps | Source (layer name as published) | Cadence | Kept by the source |
|---|---|---|---|---|
| `sst-map` | carp, lionfish | NASA GIBS WMTS `GHRSST_L4_MUR_Sea_Surface_Temperature`, `GoogleMapsCompatible_Level7`, PNG | daily (newest: the day before) | 2002 onwards |
| `radar` | all | NOAA nowCOAST WMS `conus_base_reflectivity_mosaic` (workspace `weather_radar`), MRMS, 1 km | about 4 min | about 7.5 h |
| `clouds` | all | NOAA nowCOAST WMS `goes_longwave_imagery` (workspace `satellite`), GOES-19/18 band 14, 2 km | 5 min | about 7.6 h |
| `lightning` | all | NOAA nowCOAST WMS `ldn_lightning_strike_density` (workspace `lightning_detection`), 8 km | 15 min | about 5 h |
| `cyclones` | all | NHC `CurrentStorms.json` + NWS tropical weather summary MapServer layers 5, 6, 7, 11 (forecast points, track, cone, past track), GeoJSON | per advisory (6 h, 3 h near land) | current storms |

## Capabilities documents read (2026-10-01)

The layer names, time dimensions, projections and access constraints above were read from the sources, not
assumed:

- nowCOAST radar: https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS&version=1.3.0&request=GetCapabilities
  (`conus_base_reflectivity_mosaic`, `<Dimension name="time" ... nearestValue="1">`, explicit list of instants about
  4 minutes apart over the last ~7.5 h, CRS `EPSG:3857`, `CRS:84`, `EPSG:4326`, formats `image/png` and others,
  `AccessConstraints` NONE).
- nowCOAST satellite: https://nowcoast.noaa.gov/geoserver/observations/satellite/ows?service=WMS&version=1.3.0&request=GetCapabilities
  (`goes_longwave_imagery`, 5-minute instants, bbox −179.5..−50.7, 10.9..50.6).
- nowCOAST lightning: https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows?service=WMS&version=1.3.0&request=GetCapabilities
  (`ldn_lightning_strike_density`, style `lightning_density`, 15-minute instants, bbox −180..180, −25..80).
- NASA GIBS: https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
  (`GHRSST_L4_MUR_Sea_Surface_Temperature`, "Sea Surface Temperature (L4, MUR, GHRSST)", `image/png`,
  `GoogleMapsCompatible_Level7`, Time dimension daily `P1D` with `Default` 2026-09-30 on 2026-10-01; a request for
  the current day answers 404, so the client never asks for a day newer than the day before).
- NHC: https://www.nhc.noaa.gov/CurrentStorms.json (`activeStorms[]` with `latitudeNumeric`, `longitudeNumeric`,
  `lastUpdate`, advisory numbers and URLs; `Cache-Control: max-age=300`).
- NWS tropical summary: https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer?f=json
  (capabilities `Map,Query,Data`, query formats `JSON, geoJSON, PBF`; layers 5 Forecast Points, 6 Forecast Track,
  7 Forecast Cone, 11 Past Track; features keyed by `binnumber`, e.g. `EP3`, which matches `binNumber` in
  CurrentStorms.json).

Recorded fixtures of that day live in `api/fixtures/nhc/` (three active storms: Hurricane Rachel, Tropical
Depression Nineteen-E, Tropical Storm Nolo) and drive the `nhc cyclones` tests on both sides.

## Licences and attribution

- NOAA nowCOAST products: U.S. government data under the [NOAA disclaimer](https://oceanservice.noaa.gov/disclaimer.html);
  `AccessConstraints: NONE` in every capabilities document. The lightning density map is a NOAA Level-5 derived
  product of Vaisala NLDN/GLD360 detections; its [product description](https://ocean.weather.gov/lightning/lightning_pdd.php)
  allows public distribution of the density product, not of raw detections. Credit lines: "NOAA nowCOAST, NWS/OAR
  MRMS radar", "NOAA nowCOAST, NESDIS GOES-19/18 longwave infrared", "NOAA/NWS nowCOAST lightning density, derived
  from Vaisala NLDN/GLD360".
- NASA GIBS: U.S. public domain, keyless; `AccessConstraints: none`. Credit line: "NASA GIBS, GHRSST MUR sea surface
  temperature (NASA ESDIS)". GIBS asks for the acknowledgement "We acknowledge the use of imagery provided by
  services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information
  System (ESDIS)", carried here.
- NHC / CPHC and the NWS MapServer: [NWS public-data terms](https://www.weather.gov/disclaimer), no endorsement
  implied; the MapServer's copyright text names NOAA, NWS, NHC and CPHC. Credit line: "NOAA/NWS National Hurricane
  Center and Central Pacific Hurricane Center".

While a layer is on, its credit sits on the globe's credit line (Cesium `CreditDisplay`, static credit) and under
the group in the Layers popover as a link that opens in a new tab (GC7).

## Proxy rules (`api/src/overlay.rs`)

Same as `api/src/media.rs`: a fixed allowlist (`gibs.earthdata.nasa.gov`, `nowcoast.noaa.gov`, `www.nhc.noaa.gov`,
`mapservices.weather.noaa.gov`), https only, default port, no userinfo, no IP literals, DNS answers filtered to
public addresses, redirects re-checked hop by hop (at most 3), declared and sniffed content types (PNG/JPEG/GIF/WebP
for tiles, JSON for the storm document), 2 MiB per tile and 8 MiB per document, 5 s connect and 20 s total
timeouts. The request chooses nothing but a layer id from a fixed list, `z/x/y` (bounds-checked, `z` at most 7 for
GIBS and 10 for nowCOAST) and an RFC 3339 `time` clamped to now. Tiles are cached in memory by layer, snapped time
(the UTC day for GIBS, the minute for nowCOAST), z, x and y: 2048 entries, a day for SST, an hour for the others;
the storm document for five minutes. nowCOAST picks the nearest published instant itself (`nearestValue="1"`); the
client snaps the timeline cursor to each source's cadence first (`shared/overlays.ts` `snapOverlayTime`) and the
legend shows the instant drawn ("Showing 19:36 UTC, 2026-10-01 (newest available)").

## Checks

- `cargo test --manifest-path api/Cargo.toml overlay_proxy`: allowlist, redirects, body limits, timeouts, cache
  keys, the storm document from the recorded fixtures.
- `bun test -t "overlay time"`, `-t "nhc cyclones"`, `-t "water and weather"`: snapping, clamping, the shown-time
  line, the parsed storms and the Layers group.
- `bun run e2e:overlays`: one real tile per layer and the real storm document through the running proxy (bodies
  sniffed), the radar layer stepping while the timeline plays, and the screenshots in `docs/evidence/ge5-*.png`.
