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

## J1: the judged benchmark (2026-10-01, 14:30Z)

Regex phrases replaced by judged `mustSay` statements, bars pooled over three runs (`docs/grading/judge-validation.md`). Final code; the 68-question file (this series ran before K1's python edits were merged).

| Run | Score | Failed ids |
|---|---|---|
| golden 1 (14:30:28Z) | 59/68 | py-legacy-homestead-species-counts (caveat: the answer listed tegu, anole, iguana and frog counts and never mentioned pythons; boundary 13/14), explain-activity-term (explain_cell not called), relevance-stage (the answer said the source record "does not explain why stage is included"), planning-best-night (the stored NWS forecast had one period, so no night could be named), planning-route (Big Cypress never named), sources-nas-cadence (feed_state not called), replay-scores-during-cold (below), team-notes-today and team-notes-flamingo (no note citation: nothing in the window and nothing earlier in the fixture to cite) |
| golden 2 (14:34:22Z) | 64/68 | explain-activity-term, replay-cold-snap-map (judged: "January cold-snap timeline" without "2026"; the statement over-specified the regex `(January\|2026-01)` and is reworded, `changelog`), replay-scores-during-cold, team-messages (Shark Valley never named) |
| golden 3 (14:38:19Z) | 64/68 | sources-licences (turns limit, no answer), sources-lst-number (judged: "cloud masking" not credited for "the quality flag"; statement reworded, `changelog`), sources-nas-cadence, team-notes-today |
| pooled | 187/204 (91%) | boundary 41/42, `ungrounded=0` (440 checked), views 390/390; sources 14/18, team 14/18, replay 15/18, explain 16/18, planning 16/18 |
| held-out 1 (14:42:29Z) | 32/36 | ph-planning-blind-spots (conditions, sightings not called), ph-sources-sighting-platform (no URL given), ph-sources-nas-speed (feed_state not called; "NAS" judged not to name "USGS NAS", statement reworded), ph-replay-cold-map (the January 2026 statement, reworded) |
| held-out 2 (14:44:37Z) | 32/36 | ph-change-week, ph-planning-tamiami-weekend, ph-sources-sighting-platform, ph-replay-cold-map |
| held-out pooled, first series | 64/72 (88%) | boundary 12/12, `ungrounded=0`; `met=no` on the overall bar, two of the eight misses on statements reworded afterwards |
| held-out rerun 1 (14:48:52Z), reworded statements | 32/36 | ph-relevance-stage (judged: the answer never reported the stage), ph-planning-tamiami-weekend (no weekend forecast and no horizon statement), ph-sources-nas-speed (feed_state not called), ph-team-notes-today (no note citation, the fixture gap above) |
| held-out rerun 2 (14:51:16Z) | 34/36 | ph-sources-nas-speed, ph-replay-cold-map (judged not met once more on "the January cold-snap timeline"; the question is sensitive to the judge) |
| held-out rerun pooled | 66/72 (91%) | boundary 12/12, `ungrounded=0`: `met=yes` |

Repeat failures, two of three golden runs: `explain-activity-term` and `sources-nas-cadence` are tool-sequence criteria the model skips (`explain_cell`, `feed_state`); `replay-scores-during-cold` cannot pass against the fixture stub, whose `hotspots` resolver ignores the knowledge time, so a query for January 12 returns the January 15 snapshot and the agent says, correctly, that it cannot show how the scores moved (the regex had passed it on the word "same"; fabricating a past snapshot in the fixture would be making data up, so the question stays and is logged as a harness limit); `team-notes-today` cannot cite a note because the fixture holds none in the 24-hour window and none earlier that the tool's 7-day fallback returns (a fixture gap: the criterion `cites: { note: 1 }` has nothing to point at). The boundary miss in run 1 is the caveat question answered without its subject, the fourth time AG2 and this series have seen that question flip.
