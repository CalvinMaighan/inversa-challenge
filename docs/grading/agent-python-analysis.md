# Python agent: blind re-baseline failure analysis (AG2)

Scope: the Everglades Ops (python) agent measured blind against the 68-question file `spec/apps/questions/python.json`, which replaces the 16 hand-written goldens (`eval/golden.ts` `GOLDEN`, kept for the legacy-mapping check): 16 legacy cases mapped to `py-legacy-<id>`, six of them now boundary refusals (tegu, iguana and lionfish questions) and `py-legacy-homestead-species-counts` a caveat, plus 52 new questions across the ten categories. Held-out set: `spec/apps/questions/python.holdout.json` (36 questions, 10 new). Fixture: `apps/web/eval/fixtures/graphql.json` (reference time 2026-01-15T03:00Z), extended with NWS gridpoint forecast stations, a team board, a Flamingo note linked to a python sighting, two more hotspot cells (Taylor Slough, Mahogany Hammock) and the `goes19` feed id the config uses. Model: `openai/gpt-6-luna`.

## What changed for python

- Scope: `spec/apps/python.json` `agent` block answers for Burmese python only; tegu, green iguana and lionfish stay on the map as context. A deterministic focus guard (`scope.ts`, python-scoped) refuses them by name before any model call, and topic guards refuse a percent chance, a population count, a causal mammal-decline claim, carp and places outside the region. Boundary passed 14/14 in 10 of 12 runs and 13/14 in the other two (the caveat question, not a refusal).
- Tools: `weather_forecast`, `source_info`, `evidence` and `team_board` added to the allowlist; `weather_forecast` reads by point in a species app (no configured locations) and falls back to the nearest stored gridpoint within half a degree; `alerts` and `set_view` take a place name in a species app.
- Question file fixes, logged in the file's `changelog`: the cold snap is January 2026 (the fixture's Cold Weather Advisory runs from 2026-01-14T22:00Z; February 2026 is after the reference time), the matching pass phrase follows, the scores-during-cold change verbs and the "30-day" spelling.

## Scores by round

| Round (commit) | Main set | Notes |
|---|---|---|
| 1 (a08b0f4) | 44/68, ungrounded 7 | |
| 2 (d9fe13e) | 61/68, ungrounded 0 | empty-list filters, weather by point, species-app places |
| 3 (a816076) | 60/68 | |
| 4 (43dbd07) | 62/68 | |
| 5 (8da3fa6) | 62/68 | |
| G6 series A (8da3fa6) | 67/68, 62/68, 66/68 | |
| G6 series B (03cde3c) | 61/68, 62/68, 61/68 | the per-feed `feed_state` parameter looped the model into the turn limit on two feed questions per run |
| G6 series C (ca96d63) | 66/68, 65/68, 64/68 | parameter reverted |
| G6 series D, final code (c33c0fc) | 64/68, 64/68, 63/68 | ungrounded 0 |
| Holdout series (03cde3c, ca96d63, c33c0fc) | 35/36, 30/36; 28/36, 32/36; 31/36, 30/36 | boundary 6/6 in every run except one caveat |

Honest residual failure rate, final code: main set 6.4% (13 failures over 204 question-runs, 63 to 64 of 68 per run); held-out set 15% (11 over 72). Ungrounded 0 in every run after round 2. The gate bar (95% overall) was met in 3 of 12 main runs (67, 66, 65) and never by three consecutive runs; the typical run is 94%.

## Failures seen, by class

### Class 1: tool shape (fixed, general)

- `python-quality-late`, `python-replay-arrived-after`: `quality: []` matched nothing (see the lionfish analysis). Fixed in `sightings`.
- `python-planning-route`, `python-planning-best-night`: `weather_forecast` with `site: "Shark Valley"` failed because a species app has no configured locations, and a point a few km from the stored gridpoint found nothing. Fix: by point in species apps, nearest gridpoint within 0.5°. General.
- `python-replay-step-week`: `set_view` with a place name failed in the species app, so no view event. Fix: `set_view` and `alerts` resolve a place through the gazetteer in a species app; `set_view` with no target keeps the current view and moves only the timeline. General.
- `python-change-stage-wca3a`: `conditions` returned only the latest value, so "how did the water level change this week" could not be answered. Fix: each series row carries `windowStart` (the earliest reading in the window, cited) and `changeInWindow`. General.
- `python-team-notes-flamingo`, `python-team-notes-linked`: the fixture had no note near Flamingo and no note linked to a python sighting (the only linked note was an iguana one). Fix: a Flamingo note linked to sighting 1005. Fixture.
- `python-relevance-nas`: `source_info` with feed `usgs` answered a question about USGS NAS with the river-gauge feed. Fix: `source_info` matches a feed named in words by the words it shares with the feed's id, publisher and name ("USGS NAS" scores nas 2, usgs 1). General.
- `py-legacy-quality-stale-feeds`, `python-sources-freshness` (series B): the `feed_state` `feed` parameter looped. Reverted.
- `python-boundary-causal-mammals`: the topic guard's own text said "whether pythons caused", which the question forbids. Reworded to "was caused by pythons". Guard text.

### Class 2: wording (criteria or prompt)

- `python-replay-cold-snap-map`: "(February|2026-02)" after the January rename; fixed and logged. Then "cold" and `conditions` missing in 5 of the last 9 runs: the model treats "show the hotspot map during the cold snap" as a map question and skips the temperature readings. The prompt now says any mention of the cold snap calls `conditions` with `air_c` and `lst_c` and writes "cold"; the model still skips it about half the time. Residual.
- `python-replay-scores-during-cold`: the model wrote "lower" and "declined"; the verb list was widened and logged.
- `python-replay-30d`: "30-day replay"; the span pattern takes either spelling, logged.
- `py-legacy-python-crews-tonight`, `python-planning-tamiami-weekend`, `ph-planning-tamiami-weekend`: the backtest hit rate written as a percent. The prompt says decimals as the tool gives them; residual (one run in three).
- `python-planning-cold-tonight`: "pythons will not move". The prompt forbids the three phrasings and gives the replacement ("the activity term drops"); residual (one run in three).
- `python-change-week-on-week`, `python-change-big-cypress-30d`, `ph-change-week`: the "reports are not abundance" sentence missing from a comparison. Prompt; residual.

### Class 3: tool choice (prompt; residual variance)

- `python-explain-activity-term`: `source_info` called but its marker not cited (6 of the last 9 runs). The output's `markers` line and the prompt's "paste the source row's cite" did not change this; the model treats the source row as background rather than a claim. Residual, the most persistent python failure.
- `python-sources-nas-cadence`, `python-sources-gbif-lag`, `ph-sources-nas-speed`: `feed_state` not called next to `source_info` (one run in three). Residual.
- `python-explain-taylor-slough`: `geocode` skipped when the model could guess the position (one run in three). Prompt; residual.
- `python-lookup-sightings-7d`: `set_view` not called for a region-wide listing (one run in three). Residual.
- `python-sources-licences`: four `source_info` calls, one per feed, with usgs or nws left out. Prompt asks for one call with no feed; residual.

### Class 4: disclosure of degraded feeds

- Python's `hotspots` and `explain_cell` attach every feed (`feedsFor(…, "all")`), so each such answer must name nwws (down), ndbc (stale), nas and goes19 (lagging). `feedSummary.line` and `newestAge` made this pass in most runs; it still fails about one run in five on questions where the feeds are incidental (`python-sources-nas-cadence`, `python-replay-step-week`, `python-sources-licences`).

### Class 5: the model refusing on its own

- `ph-explain-taylor` ("why is taylor slough lit up on the map"): no tool call, the refusal text returned in 1.3 s. The scope guard returns null for this question (checked); the model itself produced the refusal. Residual, seen once.

## What was not done

- No question-specific prompt text or answer key: the prompt names intents in its own words; AGB's `no answer key` test applies to python too.
- The held-out set was written before the final tuning runs and edited only for the "30-day" spelling, logged in its `changelog`.

## Cost

A full python run costs at most $0.21 (about 1.7 M input tokens, 25 k output, list price). See the lionfish analysis for the leaf total.
