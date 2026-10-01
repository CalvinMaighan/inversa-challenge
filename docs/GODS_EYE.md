# God's Eye View upgrade (GE1-GE5)

Source studied: `bilawalsidhu/gods-eye-view` (MIT code; third-party data keeps its own licences, see its `DATA_SOURCES.md`). Fetched with `opensrc path bilawalsidhu/gods-eye-view`. Files read: `DATA_SOURCES.md`, `src/scopeMask.js`, `src/ui/visualPresets.js`, `src/maps/google3d.js`, `src/data/aisStreamAdapter.js`.

We borrow ideas and our own implementations, not code, because that repo's runtime is a vanilla-JS Vite app and ours is React and Rust. Attribution for any data source we add goes in the app's attribution line and `docs/`.

## What the user asked for

1. Media must work and be cached locally (the stale local SQLite cache hid photos: fixed in `a722a6a`; GE3 adds a media cache).
2. Google Maps 3D set up, paid use accepted.
3. App look: visual presets and the scope/feather control from the reference.
4. Layout: everything centered with black on both sides; chat agent as a card on the left; sighting details as a card on the right.
5. Keep the UX clean and simple for novices (see memory `novice-sightings-focus`).
6. Carp and lionfish: ship data, timeline playback of ships moving, water temperature, richer weather events.
7. A developer icon button, top right, that reveals a panel for all API keys.

## What the reference does that applies here

| Reference feature | Our version | Leaf |
|---|---|---|
| Visual presets NORMAL, CRT, NVG, FLIR, ANIME, NOIR, SNOW as Cesium `PostProcessStage` GLSL, 500 ms crossfade | Same seven presets, GLSL written fresh, crossfade, one popover | GE2 |
| Scope mask: radial canvas, featherable edge, black outside, fades to full black below 7 Mm altitude | Same idea: the centered circular stage on black; feather slider default 11% | GE2 |
| Google Photorealistic 3D Tiles direct (`createGooglePhotorealistic3DTileset`) or via ion asset 2275207, ion as the fallback, OSM/Esri when neither | We already have the ion route and a quota guard (`client/globe/imagery.ts`, `ladder.ts`, `quota.ts`); add the direct Google key route and widen the zones to Louisiana | GE3 |
| Keys entered at runtime | Developer panel (browser-side keys in localStorage, server-side keys shown as set or missing, never their value) | GE3 |
| AISStream.io live vessels over a websocket, watchdog with backoff, 429 and auth classification | Axum websocket client per app region, vessels stored as time-series, GraphQL `vessels`, a layer that moves with the timeline | GE4 |
| NOAA nowCOAST radar (MRMS), GOES-19 IR clouds, lightning density; NHC cyclones; NASA GIBS WMTS tiles | Time-enabled overlays through a same-origin proxy (COEP require-corp needs CORS or same origin), plus GIBS sea-surface temperature and NHC storm tracks | GE5 |
| OpenSky, adsb.lol (aircraft), CelesTrak, traffic, CCTV, radio | Out of scope: not relevant to invasive-species sightings | none |

## Keys and cost

Nothing here needs an account created by the agent. The user adds keys in Doppler (server) or in the Developer panel (browser):

| Key | Where | Needed for | If missing |
|---|---|---|---|
| `NEXT_PUBLIC_CESIUM_ION_TOKEN` | Doppler (build time) or Developer panel | ion imagery, terrain, Google 3D via ion | keyless Esri imagery |
| `GOOGLE_MAPS_API_KEY` (browser key, restrict by HTTP referrer, enable Map Tiles API) | Developer panel (localStorage) or `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles direct | ion route, then keyless |
| `AISSTREAM_API_KEY` | Doppler, server only | live vessels | ships layer shows "needs AISSTREAM_API_KEY", history already stored still replays |
| `OPENROUTER_API_KEY` | Doppler, server only | the agent | agent answers 503 |
| `XAI_API_KEY` | Doppler, server only | voice | voice off |
| `GOES_SQS_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Doppler, server only | GOES push | poll feeds only |
| `NWWS_USER`, `NWWS_PASS` | Doppler, server only | NWWS push | NWS alerts poller |

Google 3D Tiles bill per root-tileset request after a free monthly allowance; check the current price at https://developers.google.com/maps/billing-and-pricing/pricing before enabling billing (unverified here). The quota guard in `client/globe/quota.ts` already limits ion usage; GE3 adds a monthly cap for the direct route, default 1,000 sessions per browser, editable in the Developer panel.

## Contracts

- **GC1 layout.** Full-viewport black page. A centered stage holds the globe, circular scope with feather. Chat is a card at the left, sighting details (evidence drawer) a card at the right, both floating over black margins on wide screens (>= 1100 px) and docked as today on narrow screens. Top-right: three icon buttons only: About/status, Theme, Developer. The bottom center bar holds Look (presets and scope) and Layers.
- **GC2 look state.** active-state keys `LOOK` (`normal|crt|nvg|flir|noir|anime|snow`, default `normal`), `SCOPE_ON` (default true), `SCOPE_FEATHER` (0..100, default 11), persisted in the share link as `look`, `scope`, `feather`. Presets are `PostProcessStage`s owned by `client/globe/look/`; the layer code never imports them.
- **GC3 keys.** `shared/keys.ts` exports `KEY_REGISTRY: {id, label, scope: "browser"|"server", purpose, getUrl, fallback}[]`. Browser keys read from localStorage `inversa:keys:<id>` first, then the build-time env. `GET /api/dev/keys` returns `{id, set: boolean}[]` for server keys, never a value. No server key value ever reaches the browser or a log.
- **GC4 vessels.** Migration `0013_vessels.sql` (reserved): `vessels(mmsi, name, type, ...)`, `vessel_positions(mmsi, observed_at, lat, lon, sog, cog, heading)`, index on `(observed_at)`. GraphQL (C2, `api/schema.graphql` updated with its `schema_matches_contract` test): `vessels(bbox, from, to, types, limit): [VesselTrack!]!`, where `VesselTrack{mmsi, name, type, points: [VesselPoint!]!}`. Evidence kind `vessel:<mmsi>` (C14 addendum). Layer id `vessels`.
- **GC5 overlays.** Layer ids `sst-map`, `radar`, `clouds`, `lightning`, `cyclones`. Raster overlays go through `GET /v1/{app}/overlay/{layer}/{z}/{x}/{y}?time=<iso>` on Axum with a fixed upstream allowlist (nowCOAST, GIBS, NHC) and the same SSRF rules as `media.rs`. Cyclones are GeoJSON from `www.nhc.noaa.gov/CurrentStorms.json` plus its track layers.
- **GC6 defaults.** Novice rule holds: only sightings and notes are on at first load. Vessels and overlays are off, one tap in the Layers popover, grouped under "Water and weather" and, for carp and lionfish, "Ships". Each layer follows the timeline: scrubbing or playing the timeline moves ships and steps overlay times.
- **GC7 external links** keep `target=_blank rel="noopener noreferrer"` via `ExternalLink`.

## Leaves, ownership, gates

| Leaf | Scope | Owns (only these) | Gates |
|---|---|---|---|
| GE1 | layout | `app/page.tsx`, `app/globals.css`, `client/hud/shell/**` (new), `client/hud/topbar/**`, `client/hud/drawer/**` styling, `client/agent/**` styling | `gates/leaf-GE1.md` |
| GE2 | look + scope | `client/globe/look/**` (new), `client/hud/look/**` (new), `client/hud/share-link*.ts` for the three keys | `gates/leaf-GE2.md` |
| GE3 | keys, Google 3D, media cache | `shared/keys.ts`, `app/api/dev/keys/route.ts`, `client/hud/developer/**` (new), `client/globe/imagery.ts`, `ladder.ts`, `quota.ts`, `client/media/**` (new) | `gates/leaf-GE3.md` |
| GE4 | vessels | `api/src/ingest/push/ais*.rs`, `api/src/vessels.rs`, `api/src/graphql/vessels.rs`, migration 0013, `api/schema.graphql` (vessel types only), `client/globe/layers/vessels.ts`, `shared/vessels.ts` | `gates/leaf-GE4.md` |
| GE5 | water and weather overlays | `api/src/overlay.rs`, `client/globe/layers/overlays/**`, `shared/overlays.ts` | `gates/leaf-GE5.md` |

Shared files that several leaves must touch (`client/globe/layers/index.ts`, `client/globe/layers/types.ts`, `shared/voice/ui-tools.ts` `LAYER_IDS`, `client/hud/legend/**`, `api/src/app/mod.rs` route merge): each leaf appends its own lines and nothing else, and the driver resolves merge conflicts. After the five merge, the driver wires the agent (`toggle_layer` ids, prompt), docs and the final e2e.
