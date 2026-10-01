# Research: what fits Inversa

Date: 2026-09-30. Sources are listed at the end. Raw scrapes are in `.firecrawl/`, which is gitignored.

## 1. Who Inversa is

- **Business:** invasive species management. The company describes itself as "the largest diversified invasive species management company in the United States" (Florida Python Challenge sponsor page). It was founded in 2020 and is based in Miami.
- **Model:** it removes invasive animals and turns the biomass into revenue (Inversa Leathers: python, lionfish and other invasive leathers, and "Silverfin", its invasive carp material). The economics pay for the removal.
- **Programs:**
  - **Burmese python, Florida Everglades.** Inversa administers FWC's PATRIC contractor program. Removals went from 235 in July 2024 to 748 in July 2025, backed by $2M in state funding (FWC release, 2025-10-21).
  - **Lionfish, Caribbean.** Mexico (Banco Chinchorro MPA), Belize, Colombia and Florida, with NOAA, ORRAA and Conservation International. Results: 40k+ fish removed, $2.1M deployed, 267 fishers employed.
  - **Invasive carp, Mississippi.** A Mississippi fisheries manager is quoted on the lionfish case page.
- **Origin, their product:** "environmental intelligence for invasive species management", described as an AI command center. Features named on the site:
  - Geospatial alerts
  - Satellite imagery
  - Real-time habitat data
  - **Predictive heatmaps** (with "Data Sources" and "Drones" listed as inputs)
  - **Body cams with AI confirmation**
  - A **field app**
  - A mission flow: "Invasive Hotspot → Initiating a Mission → Mission in Progress → Econ Metrics + ROI"
  - Stakeholder ROI reporting
- **Team signal:**
  - Head of Engineering, Head of Digital Product, and an AI Data Scientist & Deployment Engineer.
  - Scientific advisor Lily Xu (AI for invasive species; known for PAWS, predictive patrol planning for anti-poaching).
  - Expect questions on prediction, field operations and data grounding.

**Takeaway:** a submission about invasive species, in their geography, with an Origin-like loop (hotspot → mission → outcome), speaks their language directly. The brief lists iNaturalist, GBIF, eBird and NOAA as sample sources, which fits.

## 2. Feed viability (probed today)

| Feed | Probe result | Real-time? | Role |
|---|---|---|---|
| iNaturalist API v1 | `taxon_name=Python bivittatus`, Florida: 758 obs, newest **2026-09-29, Homestead FL, research grade**. `taxon_name=Pterois&introduced=true`: 5,501, newest created **today** (Martinique) | Minutes (citizen uploads) | Live sightings with photos |
| USGS NAS (Nonindigenous Aquatic Species) API v2 | `genus=Pterois&state=FL`: 7,026 records with lat/lon, HUC, accuracy | No (curated, lags weeks to months) | Authoritative historical baseline |
| GBIF occurrence API | Documented; days of ingest lag, and duplicates iNat research-grade records | No | Deep history, dedupe/conflict case |
| Open-Meteo (forecast, archive, marine) | Keyless; air temp, rain, SST, wave height | Hourly | Activity and field conditions |
| NOAA NDBC + Tides & Currents | Buoy water temp every 10 min to 1 h; water level every 6 min | Yes | Marine conditions, lionfish dive windows |
| USGS Water Data | Everglades/South Florida gage height, stage and water temp | 15 min | Habitat (water level concentrates prey and snakes) |
| NWS alerts | Freeze, cold, heat and flood alerts | Minutes | Official conditions (cold snaps suppress and kill pythons) |
| ~~NASA FIRMS~~ | ~~Fires and prescribed burns in the Everglades~~ | ~~~3 h~~ | Dropped in K1 (R14): GOES-19 FDCC covers fire for python |

The mix of live, curated and lagged sources gives the brief's "stale / missing / conflicting" story naturally:

- The same animal can appear in iNat, then in GBIF, then in NAS, weeks apart.
- A sighting can be research grade or unverified.
- A buoy can go offline.

## 3. God's Eye View (bilawalsidhu/gods-eye-view)

It is a vanilla JS + Vite + CesiumJS 1.138 "spy satellite simulator": a photoreal 3D globe with live aircraft, ships, satellites, quakes, fires and CCTV, driven by a voice agent (OpenAI Realtime over WebRTC). MIT code. The server is Vite dev middleware only and has no persistent history. Its README calls history "the expensive, unsolved part", and that is exactly the gap our brief targets.

What to borrow, ranked by value to us:

| Idea | Source | Why it matters here | Effort |
|---|---|---|---|
| Feed-state envelope on every agent answer (nominal / stale / fallback) | `src/data/feedState.js`, `layerSnapshot.js` | Stops the agent from narrating stale data as live. Maps to the brief's data-quality ask | 1 d |
| Analyst engine + tool schemas returning `{layerKey,id}` for highlighting | `src/data/analystEngine.js`, `src/voice/actionSchemas.js` | Pattern for grounded answers that drive the map | 2–3 d |
| Stale-serving, rate-governed proxy (stretches TTL as quota drops, honors 429) | `server/providers/aircraft/opensky.js` | iNaturalist asks for ~1 req/s. Same shape for our ingest Worker | 1 d |
| Interpolate one interval behind + packed binary playback buffer (48 B/fix) | `src/data/motionModel.js`, `contactPlayback.js` | Smooth replay. Packed fixes map straight onto our SharedArrayBuffer timeline | 2–3 d |
| Tactical HUD, scope mask, detection brackets with label arbitration | `src/hud.js`, `src/scopeMask.js`, `src/data/detection.js`, `labelArbiter.js` | The "command center" look Origin sells | 2–4 d |
| FLIR / NVG / CRT post-process shaders | `src/styles/*.js` | A thermal/NVG view suits night python hunts. Demo candy | 1–2 d |
| Render governor (idle to request-render mode) | `src/renderGovernor.js` | Keeps the map cheap when nothing moves | 0.5 d |
| Share links in URL hash | `src/sharelink.js` | "Send this view to the crew" | 0.5 d |
| Evidence pack revealed on an event clock | `src/data/bhoteKoshiEvent.js`, `src/scenes/nepalEvidencePack.js` | Closest thing it has to evidence-on-timeline | reference |

What to avoid:

- God modules: `gevActions.js` is 4.5k lines.
- Cesium-internal coupling and `window.__godsEyeView` globals.
- Iframe social embeds, which break COEP.
- Google Photorealistic 3D Tiles through Cesium ion, which is personal non-commercial use only.

COEP: set `Cross-Origin-Embedder-Policy: credentialless` rather than `require-corp`, self-host fonts, proxy third-party media, and use thumbnails with outbound links instead of iframes. iNaturalist photos come from `inaturalist-open-data.s3.amazonaws.com`, so we need to verify its CORS or proxy them through R2.

## 4. Options

### A. South Florida Invasives Ops (recommended)

> "Where are invasive species active across South Florida right now, and where should removal crews go next?"

- **Species:**
  - Burmese python on land (Everglades Ops).
  - Lionfish in Biscayne Bay and the Keys (Lionfish Watch, its own app).
  - Invasive carp on the Louisiana rivers (Carp Field Conditions, conditions only, no sightings).
  - Since K1 (R14) these three apps are the whole scope; no other species is planned.
- **Feeds:**
  - iNaturalist (live sightings)
  - USGS NAS (curated history)
  - GBIF (deep history and duplicates)
  - Open-Meteo forecast and marine
  - NDBC / Tides & Currents
  - USGS Water (Everglades stage)
  - NWS alerts
- **Hero features:**
  - An explainable hotspot heatmap: sighting density × condition rules (temperature window, time of night, water level, sea state), labeled as a heuristic.
  - A "Mission" card: hotspot, conditions, evidence, then pin to the team board.
  - Replay a cold snap: the NWS cold warnings, the air temperature and the python activity term respond.
- **Why:** it mirrors Origin's loop, uses their real programs and geography, and is dense enough for a good timeline.
- **Risk:** "prediction" invites scrutiny. Mitigate with transparent rules plus a backtest panel (would yesterday's heatmap have caught today's sightings?).

### B. Lionfish dive planner (Caribbean + Florida)

> "Where should lionfish removal teams dive this week?"

- **Feeds:** iNat, NAS, GBIF, Open-Meteo marine (waves, SST), NDBC, Tides & Currents, NWS marine alerts.
- **Why:** it is Inversa's flagship case study, spans multiple countries, and has clean dive-window logic.
- **Risk:** sparser real-time signal. Caribbean coverage of NDBC and NAS is thin outside the US.

### C. Invasive carp harvest radar (Mississippi basin)

> "Where are carp likely spawning and harvestable now?"

- **Feeds:** USGS streamflow + water temp (a spawn trigger: rising hydrograph + >18 °C), NAS carp records, iNat, NWS flood alerts.
- **Why:** the strongest real-time physical signal, from 15-minute USGS gages.
- **Risk:** carp sightings are rare in iNat, so evidence is mostly indirect. It is also Inversa's least visible program.

### D. Wildfire smoke (PRD v1)

- **Why:** the richest real-time data and a strong causal chain.
- **Risk:** unrelated to Inversa's business. It is a generic demo.

### Recommendation

**A**, with B's marine logic folded in for the lionfish layer. C and D become stretch "theaters" only if the architecture proves source-agnostic, which is a nice interview point.

## 5. Constraints from the user (2026-09-30)

- **Deadline:** 72 h. The PRD is sized for about 2 weeks of one senior developer. Agent tooling (Claude, Cursor) does the parallel work.
- **Domain:** `inversa.calvinmaighan.dev`.
- **active-state fork:** git subtree in this repo.
- **Low runtime budget.**
  - **Ingestion via webhooks.** None of these feeds push, so we become the emitter. Cloudflare Worker Cron Triggers poll each feed, write raw payloads to R2, and POST an HMAC-signed webhook to `inversa.calvinmaighan.dev/api/ingest/:source`. That is free-tier friendly, and the Hetzner box stays a small CX22-class VM. ~~Firecrawl monitors with webhooks are an option for sources with no API (FWC news, program pages).~~ Dropped in K1 (R14): no app needs them.
  - **Runtime LLM.** A cheap model runs the tool loop, with prompt caching on system and tool definitions, a daily spend cap (God's Eye View uses $5), and answer caching keyed by question + data version. A stronger model is used only for final synthesis when needed. Current pricing and model IDs need confirming via the `claude-api` skill before building.

## 6. Decisions (2026-09-30)

1. **Question:** A, South Florida Invasives Ops.
2. **Map engine:** CesiumJS + Cesium ion Community.
   - CesiumJS is Apache-2.0.
   - ion Community is free for "non-commercial personal projects" and "exploratory commercial or government development". This demo is a personal take-home.
   - A paid ion plan ($149/mo individual, $524/mo team) applies once the organization using it has >$50K revenue or has raised >$50K. Internal use counts.
   - Community quotas: 1,000 Google Photorealistic 3D root tiles/month and 1,000 global imagery sessions/month.
   - A keyless Esri/OSM imagery fallback kicks in when the quota nears, following God's Eye View's `src/maps/imagery.js` ladder.
3. **God's Eye View borrow level:** patterns + HUD look. No post-process shaders in the core plan.

## 7. Push-capable feeds (2026-09-30)

The brief doesn't prescribe push or poll ingest. What exists for this domain:

| Source | Push mechanism | Fit | Catch |
|---|---|---|---|
| GOES-19 via NOAA NODD on AWS | SNS topic `arn:aws:sns:us-east-1:123901341784:NewGOES19Object` | LST, SST, fire and cloud mask over the Everglades, every 5–60 min | Only SQS or Lambda subscribers, so we need an AWS account (free tier) with an SQS queue and a payload filter on the key prefix. NetCDF4 decode. |
| NWS via NWWS-OI | XMPP | Every NWS product within seconds | Account by email to `NWWS.Issue@noaa.gov`, which can take 10+ days. NWS API poll until then. |
| ~~aisstream.io~~ | ~~WebSocket~~ | ~~Vessel traffic~~ | Dropped in K1 (R14): vessel traffic serves no app |
| ~~Firecrawl monitors~~ | ~~Webhook~~ | ~~Web pages with no API (FWC program pages)~~ | Dropped in K1 (R14): no app needs them |
| iNaturalist, GBIF, USGS NAS, USGS Water, NDBC, CO-OPS, Open-Meteo | none | Core data | Polled by Axum tokio tasks under a rate governor |

## 8. Reuse from deedee and big-value (2026-09-30)

- **Agent:** deedee `server/agent-platform/cordis/*`, the npm `@deepseek-ai/cordis` + `@deepseek-ai/dsh-*` harness, with `deepseek-v4-flash` on Fireworks. It streams NDJSON through `app/api/deedee-chat/stream/route.ts` using the `DeedeeChatStreamEvent` union.
- **Voice:**
  - deedee `client/voice/*`, `server/voice/*` and `shared/voice/protocol.ts`.
  - The model is xAI `grok-voice-latest`, reached through a server relay.
  - Audio goes up as 16 kHz PCM16 and comes back as 24 kHz PCM16.
  - Grok hands work to the agent through `spawn_thinking`.
- **Morph:** deedee `client/ui/modal/morph/RectMorphPortal.tsx`, `useRectMorph`. There is no orb yet; it is new UI.
- **Axum:**
  - big-value `api/`: axum 0.8, async-graphql 7, rusqlite bundled, a broadcast Hub, and oneshot tests.
  - deedee `crates/deedee-data-plane` adds the `spawn_blocking` pattern, and `phone_api.rs` is a tokio-tungstenite client for xAI realtime.

## Sources

- [inversa.com](https://inversa.com/)
- [inversa.com/origin](https://inversa.com/origin)
- [Lionfish case study](https://inversa.com/case/lionfish-management-program)
- [inversa.com/team](https://inversa.com/team)
- [FWC: Governor highlights python removal success (2025-10-21)](https://myfwc.com/news/all-news/gov-python-removal-1025/)
- [FWC PATRIC program](https://myfwc.com/wildlifehabitats/nonnatives/python/action-team/)
- [News From The States: removals tripled](https://www.newsfromthestates.com/article/desantis-python-removal-tripled-partnering-leather-company)
- [Florida Python Challenge sponsors](https://flpythonchallenge.org/sponsors-partners/)
- [Forbes: Inversa Leathers](https://www.forbes.com/profile/inversa-leathers/)
- [USGS NAS API](https://nas.er.usgs.gov/api/v2/)
- [iNaturalist API](https://api.inaturalist.org/v1/docs/)
- [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
- [Cesium ion pricing + commercial FAQ](https://cesium.com/platform/cesium-ion/pricing/)
- [Google Map Tiles API usage and billing](https://developers.google.com/maps/documentation/tile/usage-and-billing)
- [NOAA GOES on AWS open data registry](https://registry.opendata.aws/noaa-goes/)
- [NWWS-OI request](https://www.weather.gov/nwws/nwws_oi_request)
