# Performance (PRD §13)

Every PRD §13 target measured on the real stack, with how it was measured, on the T27/T28 tree merged with main (T38, T40–T43); the poll run predates the merge, which touched no Rust. Machine: Apple Silicon Mac, headless Chromium (Playwright's `chromium-headless-shell`) with SwiftShader software WebGL, so every number that includes a globe frame is a software-rendering number; a laptop GPU renders the same frames faster. The stack is `apps/web/e2e/stack.ts`: Axum (release) over a temp data dir filled by `backfill --fixtures`, the production Next build (`next start`), the signal Worker under `wrangler dev --local`, and a Caddy-like front proxy, all on free ports.

## First agent token per app, re-measured for D1 (2026-10-01)

`doppler run --project inversa --config dev -- bun run --cwd apps/web e2e:perf --app <id>`: five of the app's golden questions to the live model on `next dev` over the fixture stub, then the first question again to hit the answer cache.

```
PERF app=carp first_token_p50_ms=1123 n=5 cached_query_ms=6 status_p50_ms=16 done_p50_ms=7263
PERF app=lionfish first_token_p50_ms=1272 n=5 cached_query_ms=12 status_p50_ms=17 done_p50_ms=9639
PERF app=lionfish first_token_p50_ms=1343 n=5 cached_query_ms=12 status_p50_ms=18 done_p50_ms=9712
```

Python exited 1 in both runs before printing its line: "the repeated question was not served from the answer cache". Its per-question first model output was 1633, 1563, 1828, 1566, 1203 ms (p50 1566) and 2485, 1452, 4125, 1584, 1240 ms (p50 1584). Against the rubric's 1,200 ms bar: carp passes, lionfish and python do not; all three are under the PRD's 2 s. The python cache miss is open.

## Three apps on the production build (H1, 2026-10-01)

Re-measured for `gates/leaf-H1.md` G6 on the three-app tree (`pivot/three-apps` at `a884526` plus H1), same machine and harness as below: the production Next build (`next build`, standalone, e2e hook on so the page reports its marks), the release Axum over each app's fixtures, SwiftShader WebGL. Every globe number is a software-rendering number.

| Budget | carp | lionfish | python | Source line |
|---|---|---|---|---|
| First globe frame (median of 5 cold loads) | 1233 ms | 1555 ms | 413 ms | `PERF cold app=<id>` |
| Hydrated (HUD takes input) | 96 ms | 98 ms | 141 ms | same |
| App switch, warm | | 93 ms (carp to lionfish, in place) | | `APPSELECT … switch_ms=93` |
| Scrub median, no network | 1.38 ms (site timeline) | 3.0 ms, 0 requests (replay) | 8.86 ms, p95 14.50 ms, 0 requests, 96/96 frames | `CARP-TIMELINE`, `LIONFISH-REPLAY`, `SCRUB` |
| Globe idle | | | 0 renders in 5 s idle, 300 animation frames, `requestRenderMode=true`, governor idle | `IDLE-FRAMES` |
| First agent token (live, 5 questions) | | | p50 1092 ms; status line p50 12 ms; first answer text p50 6.1 s | `PERF agent` |

Lines as printed:

```
PERF cold app=python runs=5 ttfb=5 dcl=33 load=118 hydrated=141 cesium_fetched=97 globe_first_frame=413 grid_ready=2130 data_drawn=2193
PERF cold app=carp runs=5 ttfb=3 dcl=32 load=73 hydrated=96 cesium_fetched=77 globe_first_frame=1233 grid_ready=-1 data_drawn=-1
PERF cold app=lionfish runs=5 ttfb=3 dcl=32 load=74 hydrated=98 cesium_fetched=77 globe_first_frame=1555 grid_ready=-1 data_drawn=-1
PERF agent questions=5 status_p50=12 first_token_p50=1092 first_text_p50=6095 done_p50=6096
APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=93
SCRUB median=8.86 requests=0 p95=14.50 work_median=0.43 frames=96 verified=96
CARP-TIMELINE series=ok thresholds=ok coverage_marker=ok conflict_chip=ok scrub_median_ms=1.38
LIONFISH-REPLAY play=ok step=ok asof=ok scrub_median_ms=3.0 requests=0
IDLE-FRAMES 0 raf=300 requestRenderMode=true governor=idle
```

Notes:

- **Every budget holds**: app switch 93 ms against 500 ms, scrub medians 1.4–8.9 ms against 16 ms with no requests, idle renders 0, first token 1.1 s against 2 s.
- **First globe frame differs by app**: python's opening view draws its first frame at 413 ms, carp and lionfish at 1.2–1.6 s (carp's first run 2.4 s). The page and Cesium arrive at the same time in all three (hydrated about 100 ms, Cesium fetched 77–97 ms), so the gap is inside the globe's own first frame for each app's opening view. H1 did not trace it (UI scope); no PRD target applies to the first frame.
- `PERF_APP=<id>` (added in H1) runs the cold loads in that app; the grid and sightings marks are python's and print `-1` elsewhere.
- `e2e:appselect` passed every check except its lionfish map-preset assertion: the camera settles at 19.58° N, 84.37° W while the script expects the middle of lionfish's four areas at 18.6° N, 81.25° W. Either the preset or the script's expected centre is stale (not a perf or H1 change); the switch timing above comes from the same run with that one assertion logged instead of failed (not committed). Left to the app's owner.
- `e2e:prod` (no credentials, production build, `INVERSA_SOURCES=off`) prints one `PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok degraded=ok` line per app; see `docs/security.md`.

Reproduce:

```
cd apps/web
bun run e2e:scrub
E2E_SKIP_BUILD=1 bun run e2e:globe
E2E_SKIP_BUILD=1 bun run e2e:perf                          # python cold + live agent (Doppler inversa/dev)
PERF_APP=carp PERF_ONLY=cold E2E_SKIP_BUILD=1 bun run e2e:perf
PERF_APP=lionfish PERF_ONLY=cold E2E_SKIP_BUILD=1 bun run e2e:perf
E2E_SKIP_BUILD=1 bun run e2e:appselect
E2E_SKIP_BUILD=1 bun run e2e:carp
E2E_SKIP_BUILD=1 bun run e2e:lionfish
```

## Targets (T27/T28, python only)

| Target | Threshold (PRD §13) | Measured | Method | Result |
|---|---|---|---|---|
| Scrub frame change | < 16 ms, SAB, no network | median 9.05 ms, p95 14.13 ms, 0 requests, 96/96 frames verified | `bun run e2e:scrub`: drag the HUD timeline over 96 EVF2 frames in a SharedArrayBuffer grid; per step, input lands at a random point of the display frame and the span runs to the next `requestAnimationFrame` after the globe stand-in redrew that frame. Requests and sockets are counted while scrubbing. | PASS |
| Cached query (client SQLite) | < 20 ms | 0.2 ms | `bun run e2e:dbworker`: a repeated `gqlRequest` answered from the db worker's SQLite cache, timed in the page (`DBWORKER cached=0.2 opfs=1 proxy=1`). | PASS |
| Voice command to globe moving | < 800 ms after end of speech | not measured | Needs the live Grok voice session; `XAI_API_KEY` is not in Doppler `inversa/dev` (checked by presence only). | ABANDON: H6, no xAI key, so no voice round trip to time |
| First agent token | < 2 s p50 | first token p50 1105 ms (1105, 1069, 1764, 939, 1201); first answer text p50 5.0 s | `bun run e2e:perf`: 5 different questions to the live agent (GPT-6 Luna on OpenRouter) through `POST /api/agent/stream` at the page origin; time from request to the first output the model streams (a reasoning or answer delta, or its first tool call). The first NDJSON line (status) arrives at p50 7 ms; the first answer text comes after the tool calls. | PASS |
| Optimistic local edit | same frame | 20/20 edits on screen before the next animation frame; DOM p50 0.8 ms | `bun run e2e:team`: A sends a chat line through the Notes tab's crew board (T43); a capture-phase submit listener arms a MutationObserver on A's own chat log and a `requestAnimationFrame` callback, which runs before the next paint; same frame when the line is already in the DOM then. | PASS |
| Edit to RTC peer | < 150 ms p50 | p50 12 ms, p95 30 ms (20 edits) | `bun run e2e:team`: two browser contexts on one WebRTC data channel; A's submit time to B's MutationObserver seeing the line, same machine clock. | PASS |
| Edit via WS fallback | < 1 s p50 | p50 84 ms, p95 91 ms (20 edits) | `bun run e2e:team` with peer traffic blocked on both sides (`__team.blockRtc`), so edits ride `applyOps` → Axum → the `ops` subscription. | PASS |
| GOES push to frame visible | < 60 s after SQS delivery | not measured | Needs the NODD SQS queue and IAM user; `GOES_SQS_URL` is not set (checked by presence only). GOES is replayed from fixtures only. | ABANDON: H4, no SQS queue to deliver from |
| Poll freshness | ≤ cadence + 2 min | 8/8 polled sources fetched within cadence + 2 min for 70 min (largest gap over its cadence: iNat 125 s against 120 s, after one failed fetch); table below | `bun run perf:poll 70`: the release Axum with every poller on, against the live upstreams, over a fresh data dir; afterwards its own `fetch_runs` give the gaps between consecutive fetches and the age at the end, and the live `feeds` give each source's newest-observation lag and state. | PASS |
| Globe idle CPU | ~0 | 0 Cesium renders over 5 s idle (300 animation frames observed, `requestRenderMode=true`, governor idle) | `bun run e2e:globe`: after the scene settles, count `scene.postRender` over 5 s with no input, and `requestAnimationFrame` callbacks alongside to prove the page was live. | PASS |

### Poll freshness per source

The target is about our polling: a source is fetched again within its cadence + 2 min. The run is 70 min, after the governor fix below. `max gap` is the longest time between two fetch runs, or from the last one to the end of the run. For NAS and GBIF (daily) the run is shorter than the cadence, so they are judged on the first fetch and on the age at the end.

| Source | Cadence | Limit | Fetches | Errors | Max gap | Newest observation lag at the end | Feed state |
|---|---|---|---|---|---|---|---|
| nws | 60 s | 180 s | 70 | 0 | 62 s | 40 s | nominal |
| inat | 120 s | 240 s | 115 | 1 | 125 s | 3591 s | lagging |
| coops | 360 s | 480 s | 151 (one run per station page) | 0 | 360 s | 686 s | lagging |
| ndbc | 600 s | 720 s | 70 | 0 | 600 s | 2006 s | lagging |
| usgs | 900 s | 1020 s | 5 | 0 | 903 s | 1406 s | lagging |
| openmeteo | 3600 s | 3720 s | 4 | 0 | 3600 s | 1406 s | nominal |
| nas | 86400 s | 86520 s | 8 (paged) | 0 | 4193 s (end age) | 131 days | stale |
| gbif | 86400 s | 86520 s | 2 (paged) | 0 | 4198 s (end age) | 10 days | lagging |

The newest-observation lag is the upstream's publishing delay, not our polling: NDBC files land 30–40 min after the hour, CO-OPS and USGS publish in batches, iNaturalist observations are uploaded long after they are made, and NAS curates months later. The feed chips show it as lagging or stale, which is the point of the envelope; the poll itself kept within its cadence on every source. The first 70-minute run, before the governor fix, passed 7/8: USGS failed once and waited 1874 s.

## Cold page load

No PRD target; measured for the record with `bun run e2e:perf`: 5 loads of the ops page `/`, each in a fresh browser context (empty HTTP cache, storage and OPFS) of one Chromium process. Medians, ms from navigation start:

| Milestone | Median | Range | What it is |
|---|---|---|---|
| TTFB | 4 | 2–5 | Navigation Timing `responseStart` |
| DOMContentLoaded | 37 | 33–44 | `domContentLoadedEventEnd` |
| Load | 79 | 75–86 | `loadEventEnd` |
| Interactive (hydrated) | 99 | 97–108 | `window.__inversa` installed by Providers' first effect: React has hydrated, the HUD takes input |
| Cesium module fetched | 97 | 97–114 | Resource Timing `responseEnd` of `/cesium/index.js` (4.7 MB) |
| First globe frame | 419 | 408–2834 | Cesium's first `postRender` |
| Frame grid ready | 2384 | 2355–2843 | the db worker published the 30-day EVF2 grid |
| First data frame drawn | 2459 | 2429–2867 | the sightings layer (on by default since T41) drew a frame of that grid |

The first load is the slow end of each range (2.8 s first globe frame): it also pays for the browser's GPU process and shader compilation under SwiftShader. On the merged tree the first globe frame comes much earlier than before the merge (median 1.7 s then); which T40–T43 change moved it was not traced. The data still waits for the db worker's 30-day grid.

Fix applied: the ops page now asks for Cesium with `preloadModule` (React DOM, `app/page.tsx`), so the 4.7 MB module downloads and compiles with the HTML instead of after hydration. Same harness before the merge, without and with it (medians of 5): Cesium fetched 371 → 105 ms, first globe frame 1974 → 1736 ms, first data frame 2866 → 2794 ms.

## Fixes made during this pass

- **Optimistic local edits.** Before: an edit appeared only after two db worker round trips (`applyLocalOps`, then `readBoard`): DOM p50 56 ms and 18/20 in the same frame. Now `client/hud/missions/team.ts` folds the node's pending ops into the last worker view on the main thread (`overlayOps` in `client/hud/missions/board.ts`, unit-tested to read the same as the worker's view after the ops): DOM p50 0.6 ms, 20/20 in the same frame.
- **Backoff after one failed poll.** In the first 70-minute live run, USGS (15-minute cadence) hit one fetch error and the governor doubled from its cadence, so the next attempt came 30 min later (gap 1874 s against a 1020 s limit). The first backoff now doubles from `min(cadence, 60 s)`: a long-cadence source retries in 2 min, then doubles towards the cap (`api/src/ingest/governor.rs`, `RETRY_BASE`, with a test for 15-minute and daily sources).
- **Cesium preload** (above).
- **Harness.** `e2e/team.ts` ran `next dev` on fixed ports 3050 and 8799, the ports of `bun run dev`; it now runs on the shared stack on free ports by default (the production build exposes `window.__team` in e2e builds only), and on T43's `e2e/dev-stack.ts` with `E2E_TEAM_STACK=dev` (merged tree: local 20/20 same frame, RTC p50 22 ms, WS p50 94 ms there). The stack's proxy had Bun's 10 s idle timeout, which could cut an agent stream while the model thought; it is 255 s now.

## Reproduce

```
cd apps/web
bun run e2e:scrub      # SCRUB …
bun run e2e:dbworker   # DBWORKER cached=…
bun run e2e:perf       # PERF cold …, PERF agent … (the Next server gets the model key from Doppler)
bun run e2e:team       # TEAM local_same_frame=… rtc_p50=… ws_p50=…
bun run e2e:globe      # IDLE-FRAMES …
bun run perf:poll 70   # POLL <source> … and POLL-SUMMARY (live upstreams, 70 min)
```
