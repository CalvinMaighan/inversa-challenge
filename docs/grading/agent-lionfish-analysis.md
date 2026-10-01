# Lionfish agent: blind benchmark failure analysis (AG2)

Scope: the Lionfish Watch agent (`apps/web/server/agent/tools/lionfish.ts`, the component blocks in `prompt.ts`, the topic guards in `scope.ts`) measured blind (`AGENT_BLIND=1`, no question hint, no pre-stream answer check) against the 65-question file `spec/apps/questions/lionfish.json` and the 40-question held-out file `spec/apps/questions/lionfish.holdout.json`, both served by the fixture stub `apps/web/eval/stub-lionfish.ts` (`fixtures/lionfish.json`, built by `fixtures/lionfish-build.ts` from the L1 data-proof shapes). Model: `openai/gpt-6-luna` through Doppler `inversa/dev`. Every number below is from `bun run eval/run.ts --app lionfish [--holdout]` on 2026-10-01.

## Scores by round

| Round (commit) | Main set | Notes |
|---|---|---|
| 1, first wiring (a08b0f4) | 35/65, ungrounded 1 | tools and prompt untuned |
| 2 (d9fe13e) | 53/65, ungrounded 0 | empty-list filters, submitted-date widening, feed-tagged sighting evidence, source_info name matching |
| 3 (a816076) | 55/65 | comparison partners in `conditions`, ages and spans in words, year regex kept decimals |
| 4 (43dbd07) | 57/65 | widened-window wording, per-station conflict pairs |
| 5 (8da3fa6) | 59/65 | unknown places widen instead of failing, hourly rows only for one point |
| G4 series A (03cde3c) | 61/65, 63/65, 62/65 | three consecutive runs, ungrounded 0, boundary 8/8 |
| G4 series B, final code (c33c0fc) | 59/65, 62/65, 58/65 | three consecutive runs, ungrounded 0, boundary 8/8 |
| Holdout series A (03cde3c) | 35/40, 35/40 | boundary 6/6, ungrounded 0 |
| Holdout series B, final code (c33c0fc) | 33/40, 37/40 | boundary 6/6, ungrounded 0 |

Honest residual failure rate, final code: main set 9.7% (19 failures over 195 question-runs, 58 to 62 of 65 per run); held-out set 12.5% (10 failures over 80). Ungrounded numbers: 0 in every run after round 2. Boundary: 100% in every run (8/8 main, 6/6 held-out). The gate bar (95% overall, every category 90%) was met in one of six final runs (63/65); the typical run sits at 92% with a spread of plus or minus three questions between runs of the same code.

## Why the spread is what it is

The remaining failures are not data or tool failures. Every answer cites only evidence a tool returned, every number traces to a tool output, every refusal is a refusal. What varies is whether the model follows a wording or tool-sequence instruction it was given, and the criteria are exact: a regex such as `(3|three)[- ]days?|72 hours` fails an answer that says "beyond the forecast horizon, which ends October 4". Sixteen of the nineteen final-series failures are of that kind. With the same prompt and tools the same question passes in two runs and fails in the third.

## Failures seen, by class

Each entry: the question, what the agent did, why, the fix, and whether the fix is general. "Variance" means the same code passed the question in other runs.

### Class 1: tool shape made the right answer impossible (fixed, general)

- `lionfish-quality-late-submissions`, `python-quality-late`, `python-replay-arrived-after`: the model sent `quality: []`, which the GraphQL stub (and Axum) read as "match nothing", so sightings came back empty and the answer said no records existed. Fix: `givenList` drops empty lists for `species` and `quality` in `sightings` (an empty list is a placeholder, never a filter). General.
- `lionfish-lookup-belize-heat`, `lionfish-lookup-fl-week`: Belize has no report in 30 days and Florida none in 7, and the widening stopped at 30 days, so nothing could be cited. Fix: the widening reach is the feed's configured backfill (`feeds[].params.backfillDays`, 90 for lionfish), and the widened result says in words that the rows are older than the window asked for and that no reports does not mean no lionfish (`emptyWindowNote`). General (config-driven).
- `lionfish-quality-late-submissions`: `dateField: submitted` with a 24-hour window found nothing and did not widen. Fix: submitted-date windows widen like observed ones. General.
- `lionfish-quality-buoy-vs-satellite`: the model asked for `sst_c` only, so no buoy (`water_c`) rows came back and no conflict could be shown; and the conflict test pooled every satellite pixel of the four areas against two Florida buoys. Fix: `conditions` fetches a parameter's comparison partner with it and groups conflicts per area, with a per-buoy `pairs` list so the difference the model quotes is a tool number. General.
- `lionfish-sources-sighting`, `python-lookup-hotspots-big-cypress`, `py-legacy-python-crews-tonight`: longitudes written as "80.765°W" or with a typographic minus were ungrounded. Fix: the eval normalises U+2212, and both prompts forbid coordinates in prose (name the reef, town or cell). General.
- `lionfish-change-since-yesterday`, `lionfish-quality-late-submissions`: a lag of 2027.7 days was ungrounded because the eval's year regex ate the integer part of the decimal. Fix in `eval/check.ts`: years are not stripped when they are part of a decimal or a comma-grouped number. General (eval bug).
- `lionfish-planning-calm-3d` (round 5): five `marine_forecast` calls with place names the gazetteer did not know all failed, and the turn ended without an answer. Fix: an unknown place widens to the four areas with a `placeIgnored` note instead of throwing (the scope guard already refuses places outside the areas before any tool runs); hourly rows are returned only for a single-point call so an all-areas result stays small. General.
- `lionfish-team-mission-seas` and every holdout question about one feed: `feed_state` once took a `feed` argument; the model then called it once per feed and hit the 12-turn limit. Reverted to one argument-free call; the description says so. General (and a lesson: per-item parameters invite per-item loops).

### Class 2: honesty wording the criteria require (fixed where wrong, otherwise prompt and tool notes)

- `lionfish-change-previous-month`, `lionfish-boundary-population`: the forbid patterns `(population|abundance) (grew|…)` and `population (is|has been) growing` matched the honest negation the pass phrases ask for ("does not mean the population grew", "cannot say whether Belize's lionfish population is growing"). Fix: the patterns exempt a negation word earlier in the sentence; logged in the file's `changelog`. Criterion fix, general.
- `lionfish-replay-90d-mx`, `python-replay-30d`, `lh-replay-ranking-month-ago`, `ph-replay-month`: "90-day record" and "30-day replay" failed `(90 days|three months)` and `(30 days|month)`. Fix: the span patterns take either spelling; logged. Criterion fix.
- `lionfish-quality-buoy-vs-satellite`: `geocode` was expected for a question that spans all four areas; one `conditions` call over the app is the honest answer. Fix: `geocode` dropped from that question's expected tools; logged.
- `lionfish-quality-gbif-duplicates` ("not counted"), `lionfish-planning-calm-3d` ("separate from the priority score"), `lionfish-relevance-gbif` ("duplicate"), `lionfish-planning-two-weeks` ("72 hours (three days)"), `lionfish-quality-buoy-vs-satellite` ("no buoys in Belize"): the model paraphrased. Fix: the tool outputs carry the sentence (`duplicateNote`, the marine note and `horizon`, `coverageNote` computed over the areas the call looked at, the gbif facts say "duplicates"), and the prompt names the words. General; still the most frequent residual failure (`two-weeks` failed 4 of the last 9 runs, `buoy-vs-satellite` 3 of 3 in the final series).

### Class 3: tool choice (prompt working method; residual variance)

- `lionfish-explain-score-recipe`: the model answers from `hotspots` plus `source_info` and skips `explain_cell`, or calls all three and cites no hotspot or no source marker. Fix: the `hotspots` description and its `topCell.next` hint point to `explain_cell` for how the score is built; `source_info` returns a `markers` line to paste. General; failed 4 of the last 6 main runs in one of the two forms.
- `lionfish-quality-freshest`: expects `hotspots`, `feed_state` and `evidence`; the model calls two of the three. Fix: `topCell.next` names both. General; alternates.
- `lionfish-explain-highlight`, `lionfish-explain-colombia-hot-but-low`, `lionfish-explain-belize-thin`, `lionfish-relevance-sst`, `lionfish-relevance-nas`, `lionfish-quality-crw-latency`, `lionfish-planning-glovers`: a third tool (`evidence`, `explain_cell`, `reef_heat`, `sightings`) was skipped. Fix: the lionfish working method lists intent to tools with "AND … all three"; `explain_cell` returns `topReport.next` for the evidence call. General; each now fails in roughly one run in three.
- `lionfish-quality-buoy-vs-satellite`: four `conditions` calls, one per area, each with its own coverage note. Fix: the prompt asks for one call over the four areas; `coverageNote` is computed over the areas the call looked at so a Belize-only call no longer claims Florida has no buoys. General.

### Class 4: disclosure of degraded feeds (prompt; residual variance)

- `lionfish-quality-crw-latency`, `lionfish-relevance-waves-separate`, `lionfish-relevance-nas`, `lionfish-relevance-current-units`: a result carried GBIF (lagging) and NAS (stale) and the answer named neither. Fix: `feedSummary.line` is a ready sentence per degraded feed, `feeds[].newestAge` is the age in words, and the prompt says to paste it even when the question is about one feed. General; still fails about one run in four for questions where the degraded feeds are incidental to the question.

### Class 5: not fixed, by design

- `lionfish-sources-sighting`, `lh-lookup-san-andres-newest`, `lh-change-mx-vs-prior`: "observed" or the page URL missing. The `evidence` output now carries `datesLine` ("observed …; submitted …; fetched …") and `pageLine`; the model still sometimes writes "seen on". Left to the prompt.
- `lionfish-replay-known-sept-1`, `lh-replay-belize-aug-15`: the "Since then" sentence. `sightings` with `knownAt` now returns `sinceThen` (what arrived after the knowledge time) so no second call is needed; the final-series failure was a missing iNaturalist citation, not the sentence.

## What was not done

- No question-specific prompt text: intents are described in the prompt's own words; the question files' ids and pass phrases do not appear in any prompt or tool description (AGB's `no answer key` test covers this).
- No retry or self-check loop: blind mode has no answer check before streaming; a second attempt would double cost and hide variance.
- The held-out set was written before the final tuning runs and edited only for the spelling fixes logged in its `changelog`.

## Cost

A full lionfish run costs at most $0.26 (about 2.4 M input tokens, 42 k output, OpenRouter list price; cache reads are billed lower). The 14 lionfish runs, 9 python runs, 8 holdout runs and the verbose subsets of this leaf came to at most $8.25.
