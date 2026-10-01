# Performance (PRD §13)

Every PRD §13 target measured on the real stack, with how it was measured, at the T27/T28 commit. Machine: Apple Silicon Mac, headless Chromium (Playwright's `chromium-headless-shell`) with SwiftShader software WebGL, so every number that includes a globe frame is a software-rendering number; a laptop GPU renders the same frames faster. The stack is `apps/web/e2e/stack.ts`: Axum (release) over a temp data dir filled by `backfill --fixtures`, the production Next build (`next start`), the signal Worker under `wrangler dev --local`, and a Caddy-like front proxy, all on free ports.

## Targets

| Target | Threshold (PRD §13) | Measured | Method | Result |
|---|---|---|---|---|
| Scrub frame change | < 16 ms, SAB, no network | median 7.72 ms, p95 13.98 ms, 0 requests, 96/96 frames verified | `bun run e2e:scrub`: drag the HUD timeline over 96 EVF2 frames in a SharedArrayBuffer grid; per step, input lands at a random point of the display frame and the span runs to the next `requestAnimationFrame` after the globe stand-in redrew that frame. Requests and sockets are counted while scrubbing. | PASS |
| Cached query (client SQLite) | < 20 ms | 0.3 ms | `bun run e2e:dbworker`: a repeated `gqlRequest` answered from the db worker's SQLite cache, timed in the page (`DBWORKER cached=0.3 opfs=1 proxy=1`). | PASS |
| Voice command to globe moving | < 800 ms after end of speech | not measured | Needs the live Grok voice session; `XAI_API_KEY` is not in Doppler `inversa/dev` (checked by presence only). | ABANDON: H6, no xAI key, so no voice round trip to time |
| First agent token | < 2 s p50 | first token p50 1017 ms (1379, 943, 1017, 945, 1306) | `bun run e2e:perf`: 5 different questions to the live agent (GPT-6 Luna on OpenRouter) through `POST /api/agent/stream` at the page origin; time from request to the first output the model streams (a reasoning or answer delta, or its first tool call). The first NDJSON line (status) arrives at p50 7 ms. | PASS |
| Optimistic local edit | same frame | 20/20 edits on screen before the next animation frame; DOM p50 0.6 ms | `bun run e2e:team`: A sends a chat line through the panel; a capture-phase submit listener arms a MutationObserver on A's own chat log and a `requestAnimationFrame` callback, which runs before the next paint; same frame when the line is already in the DOM then. | PASS |
| Edit to RTC peer | < 150 ms p50 | p50 12 ms, p95 27 ms (20 edits) | `bun run e2e:team`: two browser contexts on one WebRTC data channel; A's submit time to B's MutationObserver seeing the line, same machine clock. | PASS |
| Edit via WS fallback | < 1 s p50 | p50 82 ms, p95 87 ms (20 edits) | `bun run e2e:team` with peer traffic blocked on both sides (`__team.blockRtc`), so edits ride `applyOps` → Axum → the `ops` subscription. | PASS |
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
| TTFB | 3 | 2–5 | Navigation Timing `responseStart` |
| DOMContentLoaded | 34 | 32–45 | `domContentLoadedEventEnd` |
| Load | 95 | 68–157 | `loadEventEnd` |
| Interactive (hydrated) | 123 | 87–176 | `window.__inversa` installed by Providers' first effect: React has hydrated, the HUD takes input |
| Cesium module fetched | 105 | 85–142 | Resource Timing `responseEnd` of `/cesium/index.js` (4.7 MB) |
| First globe frame | 1736 | 1719–3674 | Cesium's first `postRender` |
| Frame grid ready | 2490 | 2438–5617 | the db worker published the 30-day EVF2 grid |
| First data frame drawn | 2794 | 2553–5709 | the hotspot layer painted a frame of that grid |

The first load of each run is the slow end of each range (3.7 s first globe frame, 5.7 s data): it also pays for the browser's GPU process and shader compilation under SwiftShader. The time from Cesium fetched to its first frame is module evaluation, widget setup and the first software-rendered frame.

Fix applied: the ops page now asks for Cesium with `preloadModule` (React DOM, `app/page.tsx`), so the 4.7 MB module downloads and compiles with the HTML instead of after hydration. Same harness, before and after (medians of 5): Cesium fetched 371 → 105 ms, first globe frame 1974 → 1736 ms, first data frame 2866 → 2794 ms.

## Fixes made during this pass

- **Optimistic local edits.** Before: an edit appeared only after two db worker round trips (`applyLocalOps`, then `readBoard`): DOM p50 56 ms and 18/20 in the same frame. Now `client/hud/missions/team.ts` folds the node's pending ops into the last worker view on the main thread (`overlayOps` in `client/hud/missions/board.ts`, unit-tested to read the same as the worker's view after the ops): DOM p50 0.6 ms, 20/20 in the same frame.
- **Backoff after one failed poll.** In the first 70-minute live run, USGS (15-minute cadence) hit one fetch error and the governor doubled from its cadence, so the next attempt came 30 min later (gap 1874 s against a 1020 s limit). The first backoff now doubles from `min(cadence, 60 s)`: a long-cadence source retries in 2 min, then doubles towards the cap (`api/src/ingest/governor.rs`, `RETRY_BASE`, with a test for 15-minute and daily sources).
- **Cesium preload** (above).
- **Harness.** `e2e/team.ts` ran `next dev` on fixed ports 3050 and 8799, the ports of `bun run dev`; it now runs on the shared stack on free ports (the production build exposes `window.__team` in e2e builds only). The stack's proxy had Bun's 10 s idle timeout, which could cut an agent stream while the model thought; it is 255 s now.

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
