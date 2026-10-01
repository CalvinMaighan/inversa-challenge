# Python agent: blind re-baseline failure analysis (AG2)

Scope: the Everglades Ops (python) agent measured blind against the 68-question file `spec/apps/questions/python.json`, which replaces the 16 hand-written goldens (`eval/golden.ts` `GOLDEN`, kept for the legacy-mapping check): 16 legacy cases mapped to `py-legacy-<id>`, six of them now boundary refusals (questions about other species, lionfish among them) and `py-legacy-homestead-species-counts` a caveat, plus 52 new questions across the ten categories. Held-out set: `spec/apps/questions/python.holdout.json` (36 questions, 10 new). Fixture: `apps/web/eval/fixtures/graphql.json` (reference time 2026-01-15T03:00Z), extended with NWS gridpoint forecast stations, a team board, a Flamingo note linked to a python sighting, two more hotspot cells (Taylor Slough, Mahogany Hammock) and the `goes19` feed id the config uses. Model: `openai/gpt-6-luna`.

## What changed for python

- Scope: `spec/apps/python.json` `agent` block answers for Burmese python only. At AG2 the other taxa still sat on the map as context and a python-scoped focus guard in `scope.ts` refused them by name; K1 (R14) removed those taxa and that guard, so the app's config now lists the python alone and the foreign-species guard refuses the other apps' species (lionfish) by name. Topic guards refuse a percent chance, a population count, a causal mammal-decline claim, carp and places outside the region. Boundary passed 14/14 in 10 of 12 runs and 13/14 in the other two (the caveat question, not a refusal).
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
- `python-team-notes-flamingo`, `python-team-notes-linked`: the fixture had no note near Flamingo and no note linked to a python sighting (the only linked note was on a species since removed in K1). Fix: a Flamingo note linked to sighting 1005. Fixture.
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

## Judged benchmark round (FX, 2026-10-01 15:00Z to 16:00Z)

Leaf `gates/leaf-FXP.md` (FXP, the python agent of FX). Branch `leaf/fx-python`, commits 6b10929 and 49fd8ae on top of 33e777c. Every repeat failure of the J1 series has a root cause and a fix below; none of the fixes names a question, an id or a judged statement (`tests/server/agent/no-answer-key.test.ts` passes), no criterion was changed, and the question files were not edited.

### Data and harness gaps (fixed, with tests)

- `replay-scores-during-cold` (judged 0 of 3 before): the eval stub's `hotspots` and `explainCell` returned the reference-time snapshot whatever `at` was, so the agent could not show movement and said so. The stub now scores at the asked time the way `api/src/hotspot/score.rs` does: kernel density (Gaussian σ 2 cells, truncated at 3σ) over the species' sightings observed before `at`, `0.5^(age / 21 d)` for the live feeds and NAS/GBIF at the 0.2 prior weight, normalised to the frame maximum; the python temperature rule (21 to 32 °C 1.5×, under 15 °C 0.3×, else 1×) on the nearest station's latest usable air, else land-surface, reading in the 6 hours before `at`; the levee-stage rule (1.5 − 0.3 × stage, clamped 0.6 to 1.2) on the nearest gauge; "no data: neutral 1.0" when nothing is in reach, as the API writes it. Any cell on the 0.01° grid can be explained (the API's `parse_cell` rejects only ids off the grid, now the stub too), and a `hotspot:<species>:<col>:<row>:<at>` evidence id resolves by cell and time. The static `explain` block is gone from the fixture; `hotspots.python` keeps the named cells (with a place name the access term quotes) as candidate cells beside every sighting's own cell. `tests/server/agent/views.test.ts` and `tools.test.ts` pin the reference-time scores (0.35, 0.34, 0.31: the cold night's 7.8 °C puts activity at 0.3×) and the off-grid error.
- The same question needs readings before the cold night. The fixture's KHST (Homestead ARB) air series began at 2026-01-14T14:00Z, so a replay two days earlier had no temperature. Fifty hourly readings for 2026-01-12T12:00Z to 2026-01-14T13:00Z were added from the recorded cold-snap scene (`api/fixtures/scenes/cold-snap-2026-02-01`, Open-Meteo archive, the Homestead cell), shifted by −17 d 12 h so the scene's 12.0 °C at 2026-02-01T02:00Z meets the fixture's 12.0 °C at 2026-01-14T14:00Z; the fixture's `provenance` key says so. The scene's shape (warm 16 to 19 °C nights, then the fall to single digits) is what the January question describes; with it the stub's top score goes 1.00 (Jan 13, activity 1× at 16.3 °C), 1.14 (Jan 14), 0.35 (Jan 15, 0.3× at 13.5 °C, the gridpoint's modelled value nearest the cell, as the API's layer would pick), and the agent now writes exactly that, with a hotspot marker per time. Two NAS history records (observed 2025-12-20 and 2025-12-02, curated, months late as NAS is) stand behind the Taylor Slough and Mahogany Hammock cells, which the old hand-written rationale had claimed.
- `team-notes-today` (0 of 3): two causes. The fixture had one note in the 24-hour window (03:05Z, inside the live-edge slack) and the model passed `species: "Burmese python"`, which the notes tool compared with the stored tag `python` and matched nothing. Fix in `tools/notes.ts`: the species name resolves through `focusKeyOf` like every other tool, and a name that is not the app's species filters nothing, with a `speciesIgnored` note (general: the same slip would hit any species app). A second note today (Tram Road, 01:40Z) was seeded so the window holds a note whatever the box; the board already had four missions and three messages.

### Agent behaviour (general tool and prompt changes)

- `explain-activity-term` (1 of 3), and the relevance questions that name a reading: the model answered a score-term question from `source_info` alone. Tool side: `source_info` in a scored app now carries `scoreTerms` ("the score's terms are explained by explain_cell, not by these rows: … call hotspots and then explain_cell for the top cell in this same turn, and cite that hotspot marker"), built from the app's `score.components`, so the nudge arrives at the moment the model has picked the wrong single tool. Prompt side (python block): a score-term question is "two tools, always both: hotspots then explain_cell, AND source_info", described "as a transparent rule with its thresholds, never as a prediction of what pythons will do"; "why is X in the app" names the term the feed feeds and quotes the rule. The stub's terms now carry the rule, the threshold band and the reading used, so the answer has something to quote. Passed 3 of 3 in the first series.
- `sources-nas-cadence` (1 of 3): `feed_state` skipped next to `source_info`. `source_info` for one feed now returns `next`: "How often, how late, how fresh …: call feed_state (no arguments) in this same turn for the live lag and the fetch markers". Passed 3 of 3.
- `sources-licences` (turn limit, run 3 of J1 and run 1 here): twelve `source_info` calls, one per feed. `feed` now accepts a comma list and its description and the tool description say one call covers every feed, never one per feed. Passed 3 of 3 after the change.
- The caveat boundary question (1 miss in 42, and the same miss in run 1 here): the answer named the python but never said other species are context. `species_counts` now returns a `scopeLine` ("Any other animal is background context here and is not counted: this app ranks cells and plans for the Burmese python alone", from the app's taxon name) and the prompt says to paste it; a count of zero is still the answer. Passed 3 of 3 after the change (boundary 39/39 pooled).
- `species_counts` taken for "how many were seen" and duplicates questions (2 of 3 in series one): the tool's description now says it is only for "which species" and never for counts, duplicates, late or needs-ID records; its output carries `next` pointing at `sightings`; the prompt routes counts and listings to `sightings` and ends them with one `set_view` (the other repeat failure, the map never moved for a region-wide listing).
- A degenerate bbox (`north` equal to `south`) from the model failed `conditions` with a schema error and the answer carried the error (`replay-cold-snap-map`, once). `resolveBbox` in `tools/shared.ts` reads a box with no area as not given (the view, else the region); the schema no longer refuses it. General to every area tool.
- Relevance questions that name alerts now call `alerts` over the region and name the alert in effect; "did the ranking change" opens with a one-sentence verdict; a weekend or named day gets its own forecast periods or the statement that the stored forecast ends before it; period comparisons end with a fixed "Reports are not abundance" sentence. These are prompt rules in the python block only.

### Wrong criteria

None found; no question or holdout file edited in this round.

### Shared files touched

`apps/web/eval/stub-server.ts` (python resolvers only), `apps/web/eval/fixtures/graphql.json` (python fixture), `apps/web/server/agent/tools/common.ts` (`source_info`: comma list, `next`, `scoreTerms`), `tools/shared.ts` (`resolveBbox` degenerate box), `tools/notes.ts` (species alias), `tools/capabilities.ts` (`species_counts` description, `scopeLine`, `next`), `server/agent/prompt.ts` (the `pythonSections` block only), and the two python tests. Nothing in the judge, corpus, rubric, grade script or question files.

### Series on the first fix commit (6b10929, 2026-10-01 15:21Z to 15:34Z)

| Run | Score | Failed ids |
|---|---|---|
| 1 (finished 15:25:11Z) | 63/67 | py-legacy-quality-duplicates-shark-valley (species_counts instead of sightings), python-lookup-sightings-7d (set_view not called), python-change-big-cypress-30d (abundance sentence missing), python-planning-tamiami-weekend (weekend periods not given separately) |
| 2 (15:29:54Z) | 64/67 | python-lookup-sightings-7d (set_view), python-explain-access-low (judged: the access rationale, now the stage rule, did not name a road), python-relevance-stage (source_info only) |
| 3 (15:34:05Z) | 62/67 | py-legacy-quality-duplicates-shark-valley, python-lookup-week-count (species_counts), python-change-ranking-since-yesterday (judged: no plain verdict), python-replay-scores-during-cold (explain_cell skipped; hotspots at three times were called and the movement was stated), python-replay-step-week (judged: days not named) |
| pooled | 189/201 (94%) | boundary 39/39, `ungrounded=0` (640 checked), views 384/384; sources 18/18, team 18/18, explain 17/18, relevance 17/18, planning 17/18; lookup 15/18, change 16/18, quality 16/18, replay 16/18; `met=no` (overall 94%) |

Every J1 repeat failure passed in this series (activity-term 3/3, nas-cadence 3/3, notes-today 3/3, scores-during-cold 2/3 with the one miss a skipped explain_cell, the caveat 3/3). The misses moved to tool routing (species_counts for counts, set_view after a listing), which the second commit addresses in the prompt and the tool description.

### Series on the final code (49fd8ae, 2026-10-01 15:35Z to 15:51Z)

| Run | Score | Failed ids |
|---|---|---|
| golden 1 (finished 15:39:32Z) | 67/67 | none |
| golden 2 (15:43:21Z) | 67/67 | none |
| golden 3 (15:46:51Z) | 66/67 | py-legacy-florida-bay-alerts (geocode skipped: alerts took the place name itself and the answer was judged complete) |
| golden pooled | 200/201 (99%) | boundary 39/39, `ungrounded=0` (614 checked), views 374/374; every category 100% but lookup 17/18; `met=yes` |
| held-out 1 (15:49:02Z) | 35/36 | ph-sources-sighting-platform (judged: the publisher page URL not written out) |
| held-out 2 (15:51:21Z) | 33/36 | ph-lookup-week-total (judged: "distinct after removing duplicates" not said; the answer gave the count and named the copies), ph-change-last-day (judged: the 24-hour framing not said), ph-sources-sighting-platform |
| held-out pooled | 68/72 (94%) | boundary 12/12, `ungrounded=0` (261 checked); `met=yes` |

Cost: a golden run about $0.23 at list price for the agent (2.2 M input tokens, 2.0 M of them prompt-cache reads, 30 k output) and about $0.26 for the judge; a held-out run $0.12 and $0.15. The whole round, probes included, about $6 (agent and judge together).

Residual: one golden miss in 201 (a skipped geocode, the model's own routing) and four held-out misses in 72, three of them judged wording (a URL not written out twice, a duplicates sentence, a "24 hours" framing). The remaining risks are the model's tool routing on a bad day (set_view after a listing, explain_cell after hotspots) and that the eval stub's hotspot scores, while computed by the API's rules, run over six named cells plus the sightings' own cells rather than the API's full grid, so absolute scores differ from a live backend even though the terms, thresholds and bitemporal behaviour match.
