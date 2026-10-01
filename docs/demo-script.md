# Demo script

A 6-minute walkthrough, then the reference material for the recorded cold snap: what is in the scene, how it was converted, where to scrub, what to ask, and what the evidence drawer shows.

State at commit `81596be`, checked against the code:

- Steps 1 to 4 and 6 work on a local run today.
- Step 5, the cold-snap replay in the UI, works since T23: a time before the live 30 days recentres the window on it (`windowFor` / `retime` in `apps/web/client/state/time.ts`), through `set_time`, `play_timeline`, agent `view` events, share links and the timeline's date field. `bun run e2e:client` checks it (`COLDSNAP ... iguana=1.58`, screenshot `docs/evidence/cold-snap.png`).
- Step 7, missions and the second browser, uses the team board from T21. Since T40 the board is the Missions tab of the chat column. `bun run --cwd apps/web e2e:team` drives this step through the Missions tab, and its lines are `TEAM rtc_p50=… converged=1` and `COUNTERS-OK OFFLINE-OK`.
- Layout (T40): the chat column is on the left and the globe on the right. `bun run --cwd apps/web e2e:layout` checks it.
- Sightings first (T41): the globe opens on sightings only, with species chips at its top left and two icon buttons at its top right, About (ⓘ) and Theme (◐). The **Layers** legend (under About, "More data (for experts)") and the help sheet (About → Help) hold everything else. `bun run --cwd apps/web e2e:firstload` and `e2e:species` check them.

## Before you start

1. Load data and start the app, as in the README:
   ```sh
   bun install
   bun run data
   bun run dev
   ```
2. The agent is the live model, `openai/gpt-6-luna` on OpenRouter. `bun run dev` reads `OPENROUTER_API_KEY` from Doppler `inversa`/`dev`; check that its first line says `agent: openrouter openai/gpt-6-luna`. If it says `agent: unavailable`, log in with `doppler login`: without the key the chat column shows `agent unavailable: OPENROUTER_API_KEY not set` (HTTP 503) and there is no scripted fallback. Answers are the model's own words, so they differ from run to run; the tools, citations and caveats are what to point at.
3. Voice needs `XAI_API_KEY`. Without it, skip the voice beat in step 3; text covers the same ground.
4. Open http://localhost:3050 in Chrome, full screen. For step 7, open a second Chrome window, not a tab, on the same URL.

## Walkthrough

### 1. Open the app (0:00–0:30)

The screen has two panes. On the left is the chat column, with the **Agent** and **Missions** tabs, the thread, and a composer with a mic button. On a first visit, a welcome above the composer says in two sentences what the map is, gives each species one plain line ("Burmese python — giant constrictor eating Everglades wildlife"), and offers example questions you can click. On the right the globe shows South Florida with nothing on it but sightings: one marker per invasive animal reported in the last 7 days, each its kind's icon in its kind's colour, brightest when newest. The timeline runs along the bottom.

1. Point at the species chips at the top left: Python, Tegu, Iguana and Lionfish first, then the animals seen most this week (brown anole, curly-tailed lizard, Cuban tree frog…), each with its kind's icon in its colour and its count, then **Other**. Hover one for its one-line description. Click Iguana to hide iguanas; Alt-click it to show only iguanas; click **All** to bring every animal back. Click **Other**: a list of every kind (snakes, lizards, turtles, frogs, birds, mammals, fish, snails, insects, spiders, plants, …) with its icon, count and switch; insects, spiders and plants start off. Expand Lizards to see the lizard species with switches of their own. The markers, the timeline line and the agent's view all follow. Next to the chips, switch the window from 7 days to 2 or 30: the counts change with it (most people upload a few days after they see an animal, which is why 7 days is the default).
2. Hover a marker: every sighting is its kind's icon, a snake for a python, a lizard for an iguana or an anole, a bird for an Egyptian goose. The tooltip leads with the species and how sure the ID is, for example `Green iguana · research · iNat · 2 h ago`. Click it: the evidence card opens with "Green iguana spotted near Coral Gables · 2 h ago · confirmed by the iNaturalist community" and the photo. Now click one of the many smaller teal lizards: "Brown anole spotted near Homestead", a lizard icon, *Anolis sagrei* · introduced lizard, a photo, one line about the species from Wikipedia, and "More about Brown anole on iNaturalist ↗". Every species gets that card; nothing is "other" any more.
3. Click **ⓘ** at the top right. About says what the map is and how fresh the data is in plain words ("Sightings checked 6 min ago"). Open **More data (for experts)**: the Layers legend with a switch and live count for stations (blue, teal and violet squares), alerts, hotspots (the violet-to-yellow haze), and land and sea temperature. Switch on Stations and hover a blue square: `USGS gauge · <station> · stage 0.24 m · 45 min ago`.
4. In About, click **Help**. The help sheet lists every control. Press Esc to close it; focus returns to ⓘ.

Say: one question, "where are invasive species active right now, and where should crews go next", four focus species among every introduced species people report, one map across land and sea. Ask the agent "What invasive animals were seen near Homestead this week?" and it answers with named species and counts, each cited to a sighting. Everything on screen comes from public feeds the API ingested, stored and can trace back to the raw bytes.

### 2. Data sources and freshness (0:30–1:15)

1. Point at the timeline's **LIVE** button: it says whether you are looking at now or the past, and turns into REPLAY when you scrub back. A small dot on ⓘ takes the worst feed's colour when a source is delayed.
2. Open ⓘ, then **Data sources**: one row per source with its health and lag, worst first, 11 in all: CO-OPS, GBIF, GOES, iNat, NAS, NDBC, NWS, NWWS, METEO, USGS and WEB, the webhook. A row off nominal shows the server's note under it.
3. The GOES row reads `down · push` with `disabled: GOES_SQS_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY not set`. A source without its account shows up as down with the reason. It is never hidden.
4. Hover the GBIF row: `gbif · poll · lagging`, `newest observation is 10d 4h old; expected within 1d (cadence + 2m)`. GBIF indexes records days after they happen.
5. Hover the NAS row: `nas · poll · stale`, `newest observation is 131d 6h old; max latency is 60d`. The curated record runs months behind.
6. Hover the iNat row: `inat · poll · lagging` with a lag in minutes, against an expected 4 (a 2-minute cadence plus 2 minutes of grace).

Those notes were read from a local run on 30 Sep 2026 about a minute after `bun run dev` started. Lags change with every poll.

Say: each row is the same envelope the agent gets with every tool result, so the agent has to say when a source it used is stale. A newcomer never needs this list: About's first lines say the same in plain words.

### 3. Ask by text, then by voice (1:15–2:30)

1. The chat column is already open on the **Agent** tab.
2. Click the "Ask the field agent…" box, type `Which data feeds are stale or down right now?` and press Enter.
3. Watch the thread: the tool timeline shows `feed_state`, then the answer streams in with numbered source chips under it. Each stale or down source is named with its state, and the chips point at each feed's last fetch run.
4. Type `Why does the top python cell score so high tonight?` and press Enter. The answer names the cell, calls the score a heuristic, and lists the terms: density, activity, access.
5. Voice, with `XAI_API_KEY` set: click the mic button next to the composer. It pulses while listening. Say "Take me to Flamingo", and the globe flies to Flamingo. Grok answers UI commands like this one itself, without calling the analytic agent. Click the mic again to stop. Without the key, type `Take me to Flamingo.` into the composer instead. The agent's `set_view` event flies the globe the same way.

### 4. Follow a citation to the raw payload (2:30–3:30)

1. Under the answer to the python question, click source chip `1`, labelled like `python cell 234:149 score 1.11`. The evidence drawer opens on the right, and the globe flies down to the cell and brackets it with a `HOTSPOT python cell …` label.
2. The drawer opens inside the globe pane, so the chat column stays in view next to it. The drawer title reads `HOTSPOT`, and under it a plain line names the species, the place and the score ("a rough guide, not a forecast"). Open **Details for experts**: the id has the form `hotspot:python:<col>:<row>:<frame ms>`, and the URL hash now carries it as `e=`, so the link reopens the same view.
3. Scroll the thread up to the feed answer and click one of its chips. The drawer switches to `DATA FETCH`. Under Details for experts: the fetch run behind that feed, with its upstream URL, fetch time, HTTP status, rows in, the raw key under `raw/<source>/<yyyy>/<mm>/<dd>/`, and the raw payload.
4. For a sighting, hover any sighting dot first. The tooltip names the species, the ID grade, the source and the age. Then click the dot. The card leads with the plain summary (what, near which place, how long ago, how sure), the photo when there is one, and **Open at iNaturalist ↗** in its header. Details for experts holds, top to bottom: the id; any DUPLICATE OF, DUPLICATES or CONFLICTS badges with their links and revisions; the source link, fetch time, ingest lag and feed state; the normalized record; and the raw payload exactly as fetched. The API cuts the inline text at 256 KB (`RAW_TEXT_CAP` in `api/src/evidence.rs`).
5. Click the source link under Details for experts. It opens the exact upstream URL the API fetched, for example the iNaturalist API query.

Say: every `[e:…]` citation is checked against the ids the tools returned in that turn. A citation the model invents is stripped before it reaches the screen.

### 5. Replay the cold snap (3:30–4:30)

What works in the UI today is the live 30-day window:

1. On the timeline, click Play. The cursor walks the window at 8 frames a second; the speed menu next to it goes from 1× to 32×.
2. Drag the scrubber. Frames come from a SharedArrayBuffer in the browser, so scrubbing makes no network request. The T18 gate measured a median frame change of 8.71 ms over 96 frames (`gates/leaf-T18.md` G2).
3. Point at the hatched stretches in the thin lane under the line. Hovering the timeline names them: "gap: no satellite data" where GOES delivered nothing usable, "gap: cloud over the satellite view" where at least half the GOES cells were masked, "gap: no sightings for 12 h or more" for a quiet stretch of every feed. The Data gaps row in About → More data (for experts) keys the colours. The app never interpolates across them.
4. Click REPLAY (the timeline's LIVE button while you are in the past) to jump back to the live edge.

The cold snap of 1 February 2026 is outside that window. Any of these moves the window there, 30 days centred on the time, and the db worker fetches its frames (Axum builds the missing ones on first request):

- type `2026-02-01` in the date field next to the Live button and press Enter (the time of day is kept);
- say or type "show the first of February 2026 at noon Miami time" (`set_time`);
- open a share link such as `http://localhost:3050/#v=1&c=25.70000,-80.30000,45000,0,-90&t=2026-02-01T17:00Z`.

The timeline's LIVE button switches to REPLAY. Switch on Hotspots (ⓘ → More data), press Play and watch the iguana hotspot at cell `292:142` double as the air drops below 10 °C, then fall back on 3 February. Clicking REPLAY returns to the current 30 days.

The same numbers come from the API, in a terminal next to the browser:

```sh
curl -s localhost:3050/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ explainCell(cell:\"292:142\", species:\"iguana\", at:\"2026-02-01T17:00:00Z\") { score terms { name value } } }"}'
```

On the `bun run data` database this returned score 0.707: density 0.353, `activity.iguana_cold_stun_easy_capture_window` 2.0, `access.land_access` 1.0. The same query at `2026-02-03T19:00:00Z` returned the cold-stun term at 1.0 and a score of 0.385. The numbers in [What to ask the agent](#what-to-ask-the-agent) come from a database with only the scene loaded. There the frame holds fewer other sightings, so the same cell reads density 0.790 and score 1.580.

### 6. Explain and backtest (4:30–5:30)

1. Hotspots are an expert layer: open ⓘ → More data (for experts) and switch on Hotspots. Click the brightest heatmap cell on the globe. The drawer opens on that hotspot. Its first section, "Why this cell", shows a HEURISTIC pill, the species and cell, the score, and a table of each term with its value, a bar and the rule's rationale.
2. Read one rationale aloud, for example the iguana cold-stun rule: "Green iguanas go torpid below about 10 °C air temperature and drop from trees".
3. Click `Backtest <species>` under the table. The Backtest panel shows HIT and BASELINE pills, the lift over baseline, and a bar per day: sightings in grey, hits in the accent colour.
4. Change the Days menu from `14 days` to `30 days`. The panel reloads. The baseline is always 10 %. HIT turns from amber to green only when it beats the baseline.
5. Click `← Explain` to go back.

Say: for each day, the grid is scored using only data from before that day, and a hit is a sighting that lands in the top 10 % of cells. The panel shows the result as measured, weak or not. Ask `How well have the python hotspot scores held up over the last two weeks?` to get the same numbers from the agent, cited as `[e:backtest:python:14]`.

### 7. Mission from a hotspot, seen in a second browser (5:30–6:30)

1. With a hotspot selected, click the **Missions tab** at the top of the chat column. Create a mission from the cell. It carries the species, the window, the conditions and the evidence.
2. The mission appears in the first window in the same frame, before any network round trip.
3. In the second window, stay on the Agent tab. A dot lights up on its Missions tab. Open the tab: the mission arrived over WebRTC, with the WebSocket path as fallback. T21's gate requires an RTC p50 under 150 ms. Both windows must converge after removal counts are incremented concurrently and after an offline edit syncs.
4. Clicking a mission's diamond on the globe opens the Missions tab and focuses that mission.

The same guarantees, shown in a terminal:

```sh
cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/client/threads/crdt   # prints "CRDT vectors passed: 14/14", 11 pass
cargo test --manifest-path api/Cargo.toml crdt                                           # 6 passed, same 14 vectors in Rust
bun run --cwd apps/signal-worker e2e                                                     # two peers over wrangler dev, prints EXCHANGE-OK
```

### Close (6:30–7:00)

Name what is not live yet: the deploy (H1–H3, H8), GOES push (H4), voice (H6) and ion imagery (H7). Each has a gate with an `ABANDON` line naming the human step, not a silent gap.

## Scene: South Florida cold snap, 30 Jan – 3 Feb 2026

A cold front came through on 31 January 2026. Metro Miami dropped to about 2 °C on the mornings of 1 and 2 February, the coldest readings of the 2024–2026 winters. Green iguanas went torpid and fell out of trees. FWC let the public bring in cold-stunned iguanas, and NBC6 reported more than 1,000 handed in at the Sunrise office on 1 February alone.

- Scene id: `cold-snap-2026-02-01`
- Window: `2026-01-30T00:00:00Z` to `2026-02-04T00:00:00Z` (five UTC days)
- Files: `api/fixtures/scenes/cold-snap-2026-02-01/` (1.3 MB), with `manifest.json` and the recorder `fetch.sh`

### Sources in the scene

| Source | What was recorded | Link |
|---|---|---|
| iNaturalist | Every observation of the four focus taxa in the bbox, observed 30 Jan – 3 Feb: 141, all green iguana. No python, tegu or lionfish reports those days. | [API query](https://api.inaturalist.org/v1/observations?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=238252,318758,35342,47284&d1=2026-01-30&d2=2026-02-03&order_by=id&order=asc&per_page=200) |
| Open-Meteo historical archive | Hourly `temperature_2m`, `precipitation`, `wind_speed_10m` at the live poller's 182-point 0.25° grid | `archive-api.open-meteo.com/v1/archive` (full URL in the manifest) |
| Open-Meteo marine | Hourly `wave_height`, `sea_surface_temperature` at the same grid | `marine-api.open-meteo.com/v1/marine` (full URL in the manifest) |
| USGS NWIS | Instantaneous values (stage, lake elevation, water temperature) for the Everglades box sites, `startDT`/`endDT` over the window | `nwis.waterservices.usgs.gov/nwis/iv/` (two 100-site requests, URLs in the manifest) |
| NWS Miami and Key West | The 21 Non-Precipitation Weather products (`NPWMFL`, `NPWKEY`) issued 30 Jan – 3 Feb, raw text from the Iowa Environmental Mesonet AFOS archive | [IEM product list](https://mesonet.agron.iastate.edu/api/1/nws/afos/list.json?pil=NPWMFL&date=2026-01-31), [VTEC events MFL 2026](https://mesonet.agron.iastate.edu/json/vtec_events_bywfo.py?wfo=MFL&year=2026) |

The key NWS events, from the IEM VTEC listing:

| Event | VTEC | In effect (UTC) | Zones |
|---|---|---|---|
| Extreme Cold Warning | `KMFL.EC.W.0001` | 1 Feb 03:00 – 15:00 | interior and southwest Florida (FLZ063, 066, 067, 068, 168) |
| Freeze Warning | `KMFL.FZ.W.0003` | 1 Feb 03:00 – 15:00 | includes Metro Broward (FLZ072) and Metropolitan Miami-Dade (FLZ074) |
| Freeze Warning | `KMFL.FZ.W.0004` | 2 Feb 00:00 – 14:00 | same metro zones |
| Freeze Warning | `KMFL.FZ.W.0005` | 3 Feb 04:00 – 14:00 | interior only |
| Cold Weather Advisory | `KMFL.CW.Y.0007` – `0009` | nights of 1, 2, 3 Feb | metro and coastal zones |
| Frost Advisory | `KMFL.FR.Y.0001` | 3 Feb 04:00 – 14:00 | FLZ073, 075, 174 |
| Cold Weather Advisory | `KKEY.CW.Y.0001`, `0002` | nights of 1 and 2 Feb | Florida Keys (FLZ076) |

The event is also confirmed by:
- Open-Meteo daily minimum at Miami (25.775 N, 80.325 W): 1.9 °C on 1 and 2 Feb, 4.6 °C on 3 Feb ([query](https://archive-api.open-meteo.com/v1/archive?latitude=25.775,25.475&longitude=-80.325,-80.475&start_date=2024-11-01&end_date=2026-03-31&daily=temperature_2m_min&timezone=America/New_York)). Homestead read 2.3 °C and 2.5 °C.
- iNaturalist iguana reports per day in the bbox: 8, 10, 63, 32, 28 for 30 Jan to 3 Feb ([histogram](https://api.inaturalist.org/v1/observations/histogram?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=35342&d1=2026-01-20&d2=2026-02-12&interval=day&date_field=observed)).
- News coverage:
  - [NBC6 Miami](https://www.nbcmiami.com/news/local/historic-cold-snap-leaves-iguanas-immobilized-in-south-florida/3757935/): over 1,000 green iguanas turned in to FWC in one day.
  - [AccuWeather](https://www.accuweather.com/en/winter-weather/florida-cold-snap-delivers-falling-iguanas-snow-flurries-and-record-breaking-lows/1859306): photos of cold-stunned iguanas in Miami Beach on 1 Feb.
  - [Miami Herald](https://www.miamiherald.com/news/weather-news/article314577533.html).

### How the payloads were converted

Everything the scene ingests is the upstream response, byte for byte. Files over about 1 MB are stored gzipped, and the loader inflates them. There are two exceptions.

- **Open-Meteo:** the archive and marine APIs answer in the same shape as the forecast API, so the `openmeteo` adapter parses them unchanged. The marine URL still starts with the marine host, which selects the marine variables.
- **NWS:** `api.weather.gov` serves only active alerts, so the scene uses IEM's text archive. Each product's raw text sits in `nws/raw/` exactly as IEM returned it. `nws/<product id>.xml` wraps that text, XML-escaped and otherwise unchanged, in the NWWS-OI groupchat stanza that the `nwws` push source receives live. The `<x>` attributes (issuance time, office, WMO header, AWIPS id) come from the IEM product id. `push::nwws::normalize_stanza` then parses segments, VTEC and UGC the same way it does live, and keys rows with the same `vtec_ext_id` the `api.weather.gov` poller uses. The IEM VTEC listings are kept in `nws/iem/` as the index.

Every payload is replayed with fetch time `replay_at` (`2026-02-04T00:00:00Z`, the window end). The real retrieval time is `recorded_at` in the manifest. Without this, the USGS adapter would drop every value as more than 30 days older than its fetch.

`sh api/fixtures/scenes/cold-snap-2026-02-01/fetch.sh` re-records the whole scene and rewrites the manifest.

## Load the scene

```sh
# into the dev database (idempotent: a second run leaves the data unchanged)
INVERSA_DATA_DIR=./data cargo run --manifest-path api/Cargo.toml -- backfill --scene cold-snap-2026-02-01

# or check it without touching any database
INVERSA_SOURCES=off cargo run --manifest-path api/Cargo.toml -- backfill --dry-run --scene cold-snap-2026-02-01
```

Measured output (dry run):

```
inat: payloads=1 rows_in=141 written=141 skipped=0 errors=0
openmeteo: payloads=2 rows_in=95520 written=95702 skipped=0 errors=0
usgs: payloads=2 rows_in=71167 written=71307 skipped=0 errors=0
nwws: payloads=21 rows_in=110 written=110 skipped=0 errors=0
scene cold-snap-2026-02-01 [2026-01-30T00:00:00Z, 2026-02-04T00:00:00Z): sightings=138 readings=165951 air_below_10c=5328 alerts=42
BACKFILL-DRY-RUN-OK
```

`written` includes the stations each reading source creates. `sightings=138` counts observations inside the UTC window. Three of the 141 were made on the evening of 3 Feb EST, which is after midnight UTC.

The test `scene_cold_snap` (`cargo test --manifest-path api/Cargo.toml scene_cold_snap`) loads the scene into memory and checks these counts, the NWS events, and the cold-stun term below.

`bun run data` loads the scene after the live backfill. On that database the scene line read `sightings=254`, not 138, because the GBIF baseline adds its own records in the same five days.

The scene is months older than the live 30-day window, so the frame builder does not pre-build it. `GET /v1/frames?from=2026-01-30T00:00:00Z&to=2026-02-04T00:00:00Z&step=60` builds them on first request. Measured: 121 hourly frames, both ends included, 15,275,820 bytes raw and 553,336 bytes gzipped.

In the UI, `set_time`, `play_timeline`, agent `view` events, share links and the timeline's date field move the window to any earlier time; the db worker then fetches that window's frames through the same endpoint. With only the fixtures and the scene loaded, the frame at `2026-02-01T17:00:00Z` reads iguana 1.58 at cell `292:142` (`bun run e2e:client`).

## Moments to scrub to

Times are UTC, with Miami local time (EST, UTC−5) in brackets.

1. **31 Jan 18:59 (1:59 PM).** NWS Miami's NPW adds the Metro Broward and Miami-Dade freeze warning (`FZ.W.0003`, action `EXA`). The alert band covers the metro from 1 Feb 03:00.
2. **1 Feb 03:00 (10 PM, 31 Jan).** The Extreme Cold Warning, Freeze Warning and Cold Weather Advisory take effect. An hour later the metro grid point (25.675 N, 80.325 W) is below 10 °C (9.0 °C at 04:00).
3. **1 Feb 12:00 (7 AM).** Coldest hour: the grid point at 25.675 N, 80.325 W reads 2.2 °C.
4. **1 Feb 15:00 – 18:00 (10 AM – 1 PM).** Iguana reports surge: 63 that day, against 8 and 10 on the two days before. Cell `292:142` (25.725 N, 80.275 W, Coral Gables / South Miami) gets three reports at 15:40–15:41 and four more from 17:43 to 18:08. At **17:00** it reads 7.0 °C and the iguana hotspot is doubled.
5. **2 Feb 12:00 (7 AM).** Second freeze night, 2.2 °C again, under `FZ.W.0004`. Reports stay high at 32.
6. **3 Feb 19:00 (2 PM).** The rebound: 19.1 °C at the same grid point. The cold-stun term drops back to 1.0 while the 1 Feb reports still carry density.

## What to ask the agent

These answers come from the live agent and need a working cold-snap window in the UI. The explain numbers below were measured on a database with only the scene loaded (`backfill --scene` into an empty data dir). With `bun run data`, the GBIF baseline changes the density normalization, and the same cell reads density 0.353 and score 0.707 at 17:00 on 1 Feb.

- "Did the cold snap change iguana reports?" Expect the daily counts (8, 10, 63, 32, 28), tied to the sub-10 °C hours and the NWS warnings. Citations should include `sighting:`, `reading:` and `alert:` ids.
- "Why is cell 292:142 hot at noon on 1 February?" Expect `explain_cell` at `2026-02-01T17:00:00Z`. Density 0.79, `activity.iguana_cold_stun_easy_capture_window` 2.0, `access.land_access` 1.0, score 1.58. Conditions: air 7.0 °C, stage 0.9 m, wave 1.3 m, wind 5.4 m/s.
- "Same cell on 3 February at 2 PM?" Expect air 19.1 °C and the cold-stun term at 1.0. Density is the frame maximum there (1.0) and the score is 1.0.
- "Which alerts were in effect overnight on 31 January?" Expect Extreme Cold Warning, Freeze Warning, Cold Weather Advisory and Wind Advisory from NWS Miami, and Cold Weather Advisory from NWS Key West.
- "Were there any python or tegu reports during the cold snap?" Expect none in the window. Tegus are in brumation (the rule suppresses them October–February), and no python observations were posted.

## What the evidence drawer should show

- **Hotspot** `hotspot:iguana:292:142:1769965200000` (1 Feb 17:00 UTC): each term with its rationale. The cold-stun rationale reads "Green iguanas go torpid below about 10 °C air temperature and drop from trees".
- **Sighting** (for example one of the three `292:142` reports):
  - the normalized iNat record (research grade, `Iguana iguana`);
  - the raw iNat page as fetched (10.6 MB, so the inline text is cut at the drawer's 256 KB cap) and its source URL (the `d1`/`d2` query above);
  - fetch time `2026-02-04T00:00:00Z`, so the ingest lag is the time from the report to the end of the window (about 2 days 7 hours for a 15:40 UTC report on 1 Feb).
- **Reading** `reading:<station_id>:air_c:<ms>:modeled`: origin `modeled`, the Open-Meteo archive URL and the raw archive response.
- **Alert** (Freeze Warning `KMFL.FZ.W.0003`):
  - event, severity `Severe`, the product headline, onset 1 Feb 03:00 UTC, expiry 15:00 UTC;
  - the raw NWWS stanza with the original NPW text inside;
  - its source URL, the IEM `nwstext` link for that product.
