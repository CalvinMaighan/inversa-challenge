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
| `FASTINO_API_KEY` | Doppler, server only | routing every question before the large model, ask-next, voice stop decision | every question goes straight to the agent |

Google 3D Tiles bill per root-tileset request after a free monthly allowance; check the current price at https://developers.google.com/maps/billing-and-pricing/pricing before enabling billing (unverified here). The quota guard in `client/globe/quota.ts` already limits ion usage; GE3 adds a monthly cap for the direct route, default 1,000 sessions per browser, editable in the Developer panel.

## Contracts

- **GC1 layout.** Full-viewport black page. A centered stage holds the globe, circular scope with feather. Chat is a card at the left, sighting details (evidence drawer) a card at the right, both floating over black margins on wide screens (>= 1100 px) and docked as today on narrow screens. Top-right: three icon buttons only: About/status, Theme, Developer. The bottom center bar holds Look (presets and scope) and Layers.
- **GC2 look state.** active-state keys `LOOK` (`normal|crt|nvg|flir|noir|anime|snow`, default `normal`), `SCOPE_FEATHER` (0..100, default 40), persisted in the share link as `look`, `scope`, `feather`. Presets are `PostProcessStage`s owned by `client/globe/look/`; the layer code never imports them.
- **GC3 keys.** `shared/keys.ts` exports `KEY_REGISTRY: {id, label, scope: "browser"|"server", purpose, getUrl, fallback}[]`. Browser keys read from localStorage `inversa:keys:<id>` first, then the build-time env. `GET /api/dev/keys` returns `{id, set: boolean}[]` for server keys, never a value. No server key value ever reaches the browser or a log.
- **GC4 vessels.** Migration `0013_vessels.sql` (reserved): `vessels(mmsi, name, type, ...)`, `vessel_positions(mmsi, observed_at, lat, lon, sog, cog, heading)`, index on `(observed_at)`. GraphQL (C2, `api/schema.graphql` updated with its `schema_matches_contract` test): `vessels(bbox, from, to, types, limit): [VesselTrack!]!`, where `VesselTrack{mmsi, name, type, points: [VesselPoint!]!}`. Evidence kind `vessel:<mmsi>` (C14 addendum). Layer id `vessels`.
- **GC5 overlays.** Layer ids `sst-map`, `radar`, `clouds`, `lightning`, `cyclones`. Raster overlays go through `GET /v1/{app}/overlay/{layer}/{z}/{x}/{y}?time=<iso>` on Axum with a fixed upstream allowlist (nowCOAST, GIBS, NHC) and the same SSRF rules as `media.rs`. Cyclones are GeoJSON from `www.nhc.noaa.gov/CurrentStorms.json` plus its track layers.
- **GC6 defaults.** Novice rule holds: only sightings and notes are on at first load. Vessels and overlays are off, one tap in the Layers popover, grouped under "Water and weather" and, for carp and lionfish, "Ships". Each layer follows the timeline: scrubbing or playing the timeline moves ships and steps overlay times.
- **GC7 external links** keep `target=_blank rel="noopener noreferrer"` via `ExternalLink`.

### Contract amendments after the merge (GE7, 2026-10-01)

What the five leaves built differs from the contracts above in these places; the amendments are the contract now.

- **GC1 breakpoints, amended.** The stage layout starts at 768 px (`STAGE_MIN_PX`, the chat sheet's breakpoint), not 1100: from 768 px the chat and sighting cards float over the black page; below about 1100 px they overlap the circle's edges but never its centre (`CENTRE_CLEAR_PX` 48); under 768 px the phone docks (full-screen globe, chat and evidence as bottom sheets). On the stage layout a left panel (carp's "Locations to review", the lionfish survey) opens in the right card region, because the chat card owns the left (`client/hud/Panel.tsx`). There is one scope: the stage shell's CSS circle mask on `[data-stage]`, driven by `SCOPE_ON` and `SCOPE_FEATHER`; GE2's shader scope stage was removed. Camera framings (the agent, carp's sites, lionfish areas, a clicked marker the sighting card would cover) fit inside the circle's opaque disc and clear of every card (`client/globe/fit.ts` `visibleRect`, `keepInView`).
- **GC2 look keys, amended.** The keys live in `client/state/look.ts` (not in `client/globe/look/`); the seven ids are shared with the server as `shared/look.ts` `LOOK_IDS`, so the agent's and the voice's `set_look` UI tool validates against the same list.
- **GC3 GET shape, amended.** `GET /api/dev/keys` answers `{id, set, source, vars, writable}[]` for server keys: `source` is `external` (shell or Doppler), `local` (`data/local-keys.env`), `pending` (saved, waiting for the dev restart) or `null` (missing); `vars` lists each variable of a multi-variable key with its own `set` and `source`; `writable` says whether this request may `POST` (development on loopback only). Still never a value.
- **GC4 vessels, amended.** The ship card's outside link is VesselFinder by MMSI (`https://www.vesselfinder.com/vessels/details/<mmsi>`, new tab); the feed id is `aisstream` (feed state, attribution "Vessel positions: AISStream.io", the agent's `vessels` tool and its citations `vessel:<mmsi>`).
- **GC5 overlay time limits, amended.** Each overlay snaps the timeline to its source's cadence and clamps it to what the source still serves, saying so ("newest available", "oldest kept by the source"): `sst-map` daily, newest about 36 h behind, a year back; `radar` 4 min, 7 h back; `clouds` 5 min, 7 h back; `lightning` 15 min, 5 h back; `cyclones` 6 h advisories, 30 days back (`shared/overlays.ts`).
- **GC6 timeline, amended.** `LayerContext.timeMs()` and `playing()` are the one cursor for every layer (`client/globe/layers/clock.ts`): TIME in a species app; in carp, `CARP.asOf` (now when live) and `CARP.replay`. The viewer refreshes the layers on TIME and on CARP; no layer subscribes to CARP itself.
- **Imagery ladder.** `ImageryPlan.google3d` is an ordered route list (`["direct", "ion"]`, whichever have keys): a failed route falls to the next, then to keyless imagery (`client/globe/ladder.ts`).
- **Agent.** The text agent has `toggle_layer` and `set_look` (the voice's UI tools, `shared/voice/ui-tools.ts`), sent to the browser as the stream's `ui` event, and, in carp and lionfish, `vessels`; `server/agent/prompt.ts` "## The map: layers, ships and looks" lists per app what it may switch.

### Contract amendments (GE9, 2026-10-01)

- **GC1 spacing.** One unit on the stage chrome: `--gap-m` (12 px; `GAP_M_PX` in `client/themes/palette.ts`, `GUTTER_PX` in `client/hud/shell/geometry.ts`) between the viewport edges, the cards, the bars and the buttons. `--chat-inset` is the chat card's right edge; each HUD control keeps one gutter from it. `--hud-top` and `--hud-bottom` are measured (the top row's bottom, the timeline's top) plus one gutter. `e2e/spacing.ts` measures the pairs.
- **GC1 top right, amended.** Four icon buttons: About, Theme, Look, Developer. Look ("Look: filters and map window") left the bottom bar, which now holds place search and Layers; its popover opens under it, right edges aligned (`PopoverBox`).
- **GC2 map window, amended (GE11).** The window is always there: no on/off, no `SCOPE_ON`. `SCOPE_SHAPE` (`circle|oval|rounded|frame`, default `circle`) and `SCOPE_SIZE` (30..100 percent of the room the shape may take, default 100) give the part that is always fully visible. `SCOPE_FEATHER` (0..100, default 40) is the soft edge and fades the map out OUTSIDE that shape: 0 is a hard edge (black beyond it), more is a longer fade down to a brighter floor (share `t` of the radius, floor `t squared`), 100 is no vignette at all. Share link `shape`, `size`, `feather` (an old `scope=` is ignored). Maths in `client/hud/shell/scope.ts`; the mask is an SVG (a floor, the shape grown by half the fade and blurred, the sharp shape on top), set as `--scope-mask` by the stage shell; the pointer is clipped to the shape only at feather 0.
- **Attribution.** The globe's credit container lives in the chat card's header row, right of the AGENT and NOTES tabs (the phone dock's top right), one line (`client/globe/credit-slot.ts`); the "Data attribution" lightbox opens over the whole page. Cross-origin provider logos (Google's) load in CORS mode so the page's COEP does not block them.

## Leaves, ownership, gates

| Leaf | Scope | Owns (only these) | Gates |
|---|---|---|---|
| GE1 | layout | `app/page.tsx`, `app/globals.css`, `client/hud/shell/**` (new), `client/hud/topbar/**`, `client/hud/drawer/**` styling, `client/agent/**` styling | `gates/leaf-GE1.md` |
| GE2 | look + scope | `client/globe/look/**` (new), `client/hud/look/**` (new), `client/hud/share-link*.ts` for the three keys | `gates/leaf-GE2.md` |
| GE3 | keys, Google 3D, media cache | `shared/keys.ts`, `app/api/dev/keys/route.ts`, `client/hud/developer/**` (new), `client/globe/imagery.ts`, `ladder.ts`, `quota.ts`, `client/media/**` (new) | `gates/leaf-GE3.md` |
| GE4 | vessels | `api/src/ingest/push/ais*.rs`, `api/src/vessels.rs`, `api/src/graphql/vessels.rs`, migration 0013, `api/schema.graphql` (vessel types only), `client/globe/layers/vessels.ts`, `shared/vessels.ts` | `gates/leaf-GE4.md` |
| GE5 | water and weather overlays | `api/src/overlay.rs`, `client/globe/layers/overlays/**`, `shared/overlays.ts` | `gates/leaf-GE5.md` |

Shared files that several leaves must touch (`client/globe/layers/index.ts`, `client/globe/layers/types.ts`, `shared/voice/ui-tools.ts` `LAYER_IDS`, `client/hud/legend/**`, `api/src/app/mod.rs` route merge): each leaf appends its own lines and nothing else, and the driver resolves merge conflicts. After the five merge, the driver wires the agent (`toggle_layer` ids, prompt), docs and the final e2e.

## Developer panel spec (from the user's reference screenshot, 2026-10-01)

A modal opened by the top-right Developer icon button, titled "Power up the globe" under a small "Provider settings" kicker, with a close button and "Esc to close". Intro: the globe works without keys; each key switches on another real feed. One row per provider in `KEY_REGISTRY`:

- status dot (green = set, grey = not set), provider name, a small priority dot (red = unlocks a headline feature such as Google 3D or the agent; yellow = optional), badges `BROWSER-SIDE` (the key runs in the browser and must be provider-restricted) and `CONFIGURED EXTERNALLY` (set through the environment or Doppler; shown, never touched);
- one plain line on what it unlocks (for example "The photorealistic 3D planet", "Live ships, worldwide", "Talk to the globe");
- a `MANAGE` link (key is set) or `GET KEY` link (not set) that opens the provider page in a new tab;
- for an unset key, a paste field (placeholder with the variable name) and one `SAVE KEYS` button for the whole panel.

Where a pasted key goes:

- **Browser-side keys** (Google Maps, Cesium ion): saved to the browser's localStorage, applied on the next globe load, never sent to our server.
- **Server-side keys** (AISStream, OpenRouter, xAI, Fastino): only in local development, on loopback, `POST /api/dev/keys` appends them to `data/local-keys.env` (gitignored, mode 0600; created if absent) and `bun run dev` restarts the API and web processes with the new values (`scripts/dev.ts` watches that file and restarts only the processes it started). In any other environment the route answers 403 and the panel shows the `doppler secrets set NAME` command to copy instead, because production keys live in Doppler. A key already set through the shell or Doppler wins over the local file and shows `CONFIGURED EXTERNALLY`.
- Values are never returned by any route, never logged, never in a screenshot (the paste field is `type=password`).

Registry rows (only keys this app really uses): Google Maps, Cesium ion, AISStream, OpenRouter, xAI voice, Fastino GLiDE.

## Later leaves (GE6-GE9) and what shipped

| Leaf | Scope | Notes |
|---|---|---|
| GE6 | place search and nearby boat ramps | Bottom-bar Search (Places API (New) text search with the browser key, local list and Photon without a key); "Boat ramps and marinas nearby" in the sighting card; `docs/places.md` |
| GE7 | integration | one scope circle, framing inside the circle, Layers popover, one carp time cursor, agent `toggle_layer`, `set_look` and `vessels` tool |
| GE8 | zoom | `+` and `-` (keys `+`, `-`, `Home`), a log-scale altitude slider with place-scale labels, Reset view, Fit sightings, 300 ms eased steps, wheel about 20 percent per notch, double click zooms to the point, ground guard (30 m with 3D tiles, 400 m on flat imagery), oblique tilt below about 5 km with Google 3D and a one-time "3D city view" hint, pinch on touch |
| GE9 | spacing, Look, scope, credit | one 12 px unit (`--gap-m`, `GUTTER_PX`) on the stage chrome, Look as the third icon in the top-right cluster with a right-aligned popover, the map window as three independent controls (shape circle, oval, rounded or frame; size 30 to 100 percent; soft edge), the Cesium, Google and Esri attribution in one row in the chat card header |

GC2 amendment: the look keys are `LOOK`, `SCOPE_FEATHER`, `SCOPE_SHAPE` and `SCOPE_SIZE`, registered in `client/state/look.ts`; the share link carries `look`, `shape`, `size`, `feather` (GE11 removed the window on/off).

Known limits: the scope switch has no effect below 768 px (the circle exists on the stage layout only); radar, cloud and lightning sources keep about 7 hours, so far back on the 30-day timeline they show their oldest frame, labelled; Google 3D needs a key whose referrer list includes the page's origin (a different local port gets `API_KEY_HTTP_REFERRER_BLOCKED`).
