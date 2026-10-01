# Demo script

A 5-minute path through all three apps, then reference material for the python cold-snap scene. Written for leaf D1 on 2026-10-01 against the code on `leaf/d1`. Answers come from the live model, so their words change from run to run; point at the tools, citations and caveats, not the phrasing.

## Before you start

```sh
bun install
bun run data      # live backfill for carp, lionfish and python, then the python cold-snap scene
bun run dev       # its first line should say: agent: openrouter openai/gpt-6-luna
```

- The agent needs `OPENROUTER_API_KEY`, which `bun run dev` reads from Doppler `inversa/dev`. Without it the chat shows `agent unavailable` (HTTP 503) and there is no scripted fallback.
- Open http://localhost:3050 in Chrome, full screen. For the last beat, open a second Chrome window (not a tab) on the same URL.
- Without network, load fixtures per app instead of `bun run data`: `INVERSA_SOURCES=off cargo run -q --release --manifest-path api/Cargo.toml -- backfill --fixtures --app carp` (and `--app lionfish`, `--app python`). The fixture clocks are 2026-09-30 for carp and lionfish; python's newest fixture sighting is 2026-09-14.

## The 5-minute path

### 0:00 to 0:20: one engine, three apps

The page opens on carp. Click the round icon at the top left of the globe: the app selector lists Carp Field Conditions, Lionfish Watch and Everglades Ops, each with its one-line question and a feed-health dot. Say: one engine, three questions; each app has its own feeds, data files, score, agent and benchmark, and the URL (`?app=`) says which one you are in.

### 0:20 to 2:00: carp, river conditions in Louisiana

1. **Board.** "Locations to review" lists the eight demonstration sites: needs review, no rule fired, or cannot be assessed, each with its reasons in words. Click **Atchafalaya Basin (L'CARP)**: L'CARP is LDWF's carp program run by Inversa and active only in that basin (source in `docs/interview-notes.md`).
2. **A site.** Click KRZL1, Krotz Springs. The timeline draws USGS gauge height and NWPS observed stage, the NWPS forecast, the spread of recent issuances and the flood thresholds. The "sources disagree" chip explains the datum offset between the two gauges: flood categories come from NWPS stage only.
3. **What we knew.** Press **What we knew yesterday afternoon**. The forecast swaps to the one issued at or before that time, labelled with its issuance and source (`nwps-live` or `iem-archive`); observations after that time are drawn apart as what happened next; the board is recomputed as of then. Press LIVE to return.
4. **Ask.** Click the starter chip "Which location had the largest 24 h stage rise?". The tool rows show `river_readings` or `site_status`; click a citation and the drawer opens on the reading with units, time, datum and the publisher's page in a new tab.

Say: the feeds describe the river, not the carp. Ask "How many carp are at Simmesport?" and the agent refuses: no feed here can establish abundance (`gates/leaf-AG1.md` G3).

### 2:00 to 3:15: lionfish, survey priority in four Caribbean areas

1. Switch to Lionfish Watch with the app selector. Read the banner aloud: reports are not abundance, heat stress is context, priority is not a probability.
2. In the **Lionfish survey** panel, Belize and Colombia carry "Thin data". Switch **Observed date** to **Submitted date**: the counts change, and the note under them says why (median upload lag 5 days; 24 of 74 recent records uploaded more than 30 days after the dive, from `docs/evidence/data-proof.md`).
3. Click a numbered priority cell: four components side by side (recent reports, ID quality, heat stress, completeness), DHW and BAA together, and the field window kept apart from priority.
4. Click the chip "Show recent lionfish reports near reefs with elevated heat stress in Belize.". Expect the answer to say Belize has few or no recent reports and that no reports does not mean no lionfish.

### 3:15 to 4:25: python, Everglades Ops

1. Switch to Everglades Ops. Snake markers are Burmese python reports in the last 7 days. Hover one for the ID grade and source; click it for the evidence card, then **Details for experts** for the raw payload.
2. Click the chip "Which cells rank highest for a removal crew tonight, and why?". The answer names the score's terms (density, activity, access) and calls the score a heuristic.
3. Type `2026-02-01` in the date field beside LIVE and press Enter: the window moves to the February 2026 cold snap. Under About (ⓘ), More data, switch on Alerts and Hotspots and press Play: the NWS freeze and cold warnings outline the metro and the hotspot haze dims while air is below 15 °C.
4. Scrub the timeline: frames come from a SharedArrayBuffer, so scrubbing makes no network request.

### 4:25 to 5:00: two browsers, notes and direct messages

1. In both windows open the same app and the **Notes** tab.
2. In window A, pick a spot on the globe and start a note. Window B shows the pin and the text as it is typed, with A's caret.
3. Open a direct message from A to B and type: B sees each keystroke and an "is typing" line; Enter commits it, and it survives a reload.

Say: this is CRDT ops over WebRTC data channels, with the GraphQL WebSocket as fallback and durable copy. Measured: per-keystroke DM p50 26 ms, live note edit p50 32 ms (`gates/leaf-M1.md`).

### Close

Name what is not live: the deploy (human steps in `docs/HUMAN_STEPS.md`), GOES-19 and NWWS-OI push (accounts pending; both read DOWN with the reason), voice (no xAI key), and the agent benchmark bars (grounding holds; accuracy is 92 to 97% per run, not 95% three times in a row; `docs/brief-compliance.md` row 23).

## Checks behind the demo

| Beat | Command | Line it prints |
|---|---|---|
| App selector | `bun run --cwd apps/web e2e:appselect` | `APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=…` |
| Carp board, timeline, what we knew, evidence | `bun run --cwd apps/web e2e:carp` | `CARP …`, `CARP-TIMELINE …`, `CARP-ASOF …`, `CARP-EVIDENCE …` |
| Lionfish areas, card, quality, replay | `bun run --cwd apps/web e2e:lionfish` | `LIONFISH …`, `LIONFISH-CARD …`, `LIONFISH-QUALITY …`, `LIONFISH-REPLAY …` |
| First load per app, screenshots | `bun run --cwd apps/web e2e:firstload --app carp --evidence-shots` | `FIRSTLOAD … app=carp` |
| Python scrub | `bun run --cwd apps/web e2e:scrub` | `SCRUB median=… requests=0 …` |
| Cold-snap window | `bun run --cwd apps/web e2e:client` | `COLDSNAP … python_max=…` |
| Direct messages | `bun run --cwd apps/web e2e:dm` | `DM chars_streamed=40/40 …` |
| Notes | `bun run --cwd apps/web e2e:notes` | `NOTES … live_edit=ok caret=ok converge=ok …` |

## Scene: South Florida cold snap, 30 Jan to 3 Feb 2026

A cold front came through on 31 January 2026. Metro Miami dropped to about 2 °C on the mornings of 1 and 2 February. NWS Miami issued an Extreme Cold Warning and Freeze Warnings, and NWS Key West Cold Weather Advisories. Burmese pythons are tropical: below 15 °C the app's activity rule drops to 0.3×.

- Scene id: `cold-snap-2026-02-01`, python app only
- Window: `2026-01-30T00:00:00Z` to `2026-02-04T00:00:00Z`
- Files: `api/fixtures/scenes/cold-snap-2026-02-01/`, with `manifest.json` and the recorder `fetch.sh`

### Sources in the scene

| Source | What was recorded | Link |
|---|---|---|
| iNaturalist | Every Burmese python observation in the bbox observed 30 Jan to 3 Feb: 0. The empty page is kept so the replay says so from real data | [API query](https://api.inaturalist.org/v1/observations?swlat=24.3&swlng=-83.2&nelat=27.5&nelng=-79.8&taxon_id=238252&d1=2026-01-30&d2=2026-02-03&order_by=id&order=asc&per_page=200) |
| Open-Meteo historical archive | hourly air temperature, precipitation, wind at the poller's 0.25° grid | `archive-api.open-meteo.com/v1/archive` (full URL in the manifest) |
| Open-Meteo marine | hourly wave height and sea surface temperature at the same grid | `marine-api.open-meteo.com/v1/marine` |
| USGS NWIS | instantaneous stage, lake elevation and water temperature for the Everglades box | `nwis.waterservices.usgs.gov/nwis/iv/` |
| NWS Miami and Key West | the 21 Non-Precipitation Weather products issued 30 Jan to 3 Feb, raw text from the Iowa Environmental Mesonet AFOS archive | [IEM product list](https://mesonet.agron.iastate.edu/api/1/nws/afos/list.json?pil=NPWMFL&date=2026-01-31), [VTEC events MFL 2026](https://mesonet.agron.iastate.edu/json/vtec_events_bywfo.py?wfo=MFL&year=2026) |

Key NWS events, from the IEM VTEC listing:

| Event | VTEC | In effect (UTC) | Zones |
|---|---|---|---|
| Extreme Cold Warning | `KMFL.EC.W.0001` | 1 Feb 03:00 to 15:00 | interior and southwest Florida |
| Freeze Warning | `KMFL.FZ.W.0003` | 1 Feb 03:00 to 15:00 | includes Metro Broward and Metropolitan Miami-Dade |
| Freeze Warning | `KMFL.FZ.W.0004` | 2 Feb 00:00 to 14:00 | same metro zones |
| Cold Weather Advisory | `KMFL.CW.Y.0007` to `0009` | nights of 1, 2, 3 Feb | metro and coastal zones |
| Cold Weather Advisory | `KKEY.CW.Y.0001`, `0002` | nights of 1 and 2 Feb | Florida Keys |

Also confirmed by the Open-Meteo archive daily minimum at Miami (1.9 °C on 1 and 2 February) and by [Miami Herald coverage](https://www.miamiherald.com/news/weather-news/article314577533.html).

### How the payloads were converted

Everything the scene ingests is the upstream response, byte for byte, with two exceptions. Open-Meteo's archive answers in the forecast API's shape, so the same adapter parses it. NWS: `api.weather.gov` serves only active alerts, so each IEM product's raw text is wrapped, unchanged, in the NWWS-OI stanza the `nwws` push source receives live, and parsed by the same code. Every payload is replayed with fetch time `2026-02-04T00:00:00Z`; the real retrieval time is `recorded_at` in the manifest.

### Load and check the scene

```sh
# into the python app's database (idempotent)
INVERSA_DATA_DIR=./data cargo run -q --release --manifest-path api/Cargo.toml -- backfill --app python --scene cold-snap-2026-02-01

# or check it without touching any database
INVERSA_SOURCES=off cargo run -q --release --manifest-path api/Cargo.toml -- backfill --dry-run --app python --scene cold-snap-2026-02-01
```

The dry run, re-measured 2026-10-01, prints: iNat 1 payload, 0 rows; Open-Meteo 2 payloads, 95,520 rows; USGS 2 payloads, 71,167 rows; NWWS 21 payloads, 110 rows; then `scene cold-snap-2026-02-01 … sightings=0 readings=165951 air_below_10c=5328 alerts=42` and `BACKFILL-DRY-RUN-OK`. The test `cargo test --manifest-path api/Cargo.toml scene_cold_snap` checks the same counts, the three NWS event types and the python activity term at cell `292:142` (passes, re-run 2026-10-01).

The scene is older than the live 30-day window, so its 121 hourly frames are built on first request to `/v1/python/frames`.

### Moments to scrub to (UTC, Miami time in brackets)

1. **31 Jan 18:59 (1:59 PM).** NWS Miami adds the metro freeze warning (`FZ.W.0003`).
2. **1 Feb 03:00 (10 PM, 31 Jan).** Extreme Cold Warning, Freeze Warning and Cold Weather Advisory take effect.
3. **1 Feb 12:00 (7 AM).** Coldest hour: about 2.2 °C at the metro grid point.
4. **1 Feb 17:00 (noon).** Cell `292:142` (Coral Gables / South Miami): air still about 7 °C, activity term 0.3×.
5. **3 Feb 19:00 (2 PM).** The rebound: about 19 °C, activity term back to 1.0.

### What to ask the agent in the scene

- "Did the cold snap change python activity?": expect the activity term at 0.3× during the sub-15 °C hours, tied to the NWS warnings, and the statement that no python reports were posted in the window; citations of `reading:` and `alert:` ids.
- "Which alerts were in effect overnight on 31 January?": the warnings and advisories above.
- "Were there any python reports during the cold snap?": none.

The same terms from the API, while `bun run dev` runs:

```sh
curl -s localhost:3050/v1/python/graphql -H 'content-type: application/json' \
  -d '{"query":"{ explainCell(cell:\"292:142\", species:\"python\", at:\"2026-02-01T17:00:00Z\") { score terms { name value } } }"}'
```
