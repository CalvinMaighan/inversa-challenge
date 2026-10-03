# First-run gate

Every page load opens behind a blurred full-screen gate (`apps/web/client/intro`). Evidence: `docs/evidence/intro-gate-pick.jpg`, `intro-gate-enter.jpg`, `intro-entered-lionfish.jpg`.

## Steps

1. **Load.** A head script marks `<html data-intro>` before first paint, so the stylesheet hides the chat card and the HUD from the first frame (`[data-slot="hud"]`, `[data-slot="side"]`). The gate itself is server-rendered. The globe parks high (16,000 km) over the Americas. React removes unknown attributes from `<html>` while hydrating, so the head script also sets `window.__inversaIntro`, and the gate puts the attribute back in its first layout effect, before any paint.
2. **Pick.** Three cards (icon, name, area, one line, what the app offers). The click calls `switchApp`, so that species' workers and layers start at once; the camera stays high.
3. **Enter.** One button asks for the microphone through `startVoice({ welcome: true })`. The session opens with `?welcome=1`, so the relay's first spoken line is "Welcome to the Inversa Experience ... how can I help ... click any dot". Granted: the gate blurs out over 1.1 s, the chrome fades in, the globe flies to the app's area at 5,000 km (`entryView`). Refused: the gate stays, says why and offers "Continue without voice".

## Preload

`client/intro/preload.ts`, started at hydration:

| Data | How | Where it lands |
| --- | --- | --- |
| carp sightings (2 years) | `loadFish()` once | the carp store, in memory |
| lionfish and python frame chunks (2 years, hourly) | `fetch` of the exact chunk URLs the db worker asks for, 4 at a time, newest first, `priority: low` | the HTTP cache (API sends `private, max-age=300`), then the app's own SQLite once its worker boots |

The active app is skipped (its own workers load it). Progress shows in the gate as the share of requests settled.

Honest limits: frame chunk URLs shift every hour (the axis starts at the hour two years back), so the HTTP cache helps within the hour; return visits are served by each app's OPFS SQLite for the apps visited. The chat and voice agent do not use the browser's copy: their tools read the API's SQLite directly. `carp_sightings` defaults to the two years; the python and lionfish `sightings` tool reaches two years back when the question asks (`hours` up to 17,544, fetched in parallel 31-day pages) and defaults to the app's own window otherwise.

## Skipping

`?intro=0`. Automated browsers (`navigator.webdriver`) skip it unless `?intro=1`, so the e2e scripts are unchanged. A refresh clears the old `#` camera so the globe starts high again.
