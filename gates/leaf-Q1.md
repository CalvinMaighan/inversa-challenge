# Gates: Q1 supported chat questions (opus)

Owns: `docs/questions.md`, `spec/apps/questions/{carp,lionfish,python}.json`, `scripts/check-questions.ts`, and the `check:questions` script line in the root `package.json`. Do not edit other files. Do not commit.

Context: three apps. Read `docs/TASK_BRIEF.md`, `docs/APPS.md`, `docs/LIONFISH_WATCH.md`, `docs/evidence/{data-proof,carp-data-proof}.md`, existing `apps/web/eval/golden.ts` (python questions, keep their ids as `py-legacy-*` mapped into the new set), `apps/web/server/agent/tools/*` (what tools exist) and `api/schema.graphql`. The questions file is the source of truth for the benchmark golden sets and for the UI helper questions.

Categories (every app, at least 6 questions each, at least 48 per app): `lookup` (what is where/now), `change` (compare in time, deltas), `explain` (why highlighted / why needs review), `relevance` (what does this ocean/river/weather measure mean for the mission and why it is used), `quality` (stale, missing, conflicting, duplicate, late), `planning` (where to go next / fieldwork windows), `sources` (where does this number come from, licence, freshness), `replay` (what did we know at time T; carp-heavy), `boundary` (must refuse or caveat: out of scope species or area, abundance, causality, catch, safe trip, risk percent), `team` (notes, messages, missions).

- [x] G1: each JSON entry has `id`, `app`, `category`, `question`, `intent` (one sentence), `expectedTools` (names that exist in the agent tool registry or are listed in `newTools` with a short spec when they must be created), `mustCite` (feed or source ids), `view` (optional expected map/timeline change), `pass` (observable criteria: phrases, numbers must trace to tool output, must disclose feed state, must refuse), `helper` (true for the 6 to 8 per app shown as UI starter chips); the checker validates the schema, unique ids, minimum counts, and category coverage per app
  CHECK: bun scripts/check-questions.ts 2>&1 | tail -4
  EXPECT: /QUESTIONS carp=\d+ lionfish=\d+ python=\d+ categories=10\/10 ok/
  EVIDENCE: `QUESTIONS carp=69 lionfish=65 python=68 categories=10/10 ok`, 0 ERR lines. Tool names resolved from `buildAgentRegistry` source (geocode, sightings, species_counts, conditions, alerts, hotspots, explain_cell, backtest, feed_state, notes, set_view) plus 11 specced newTools. Checker also rejects trivial regexes, answers without tools/citations, non-boundary refusals, boundary answers without `forbid`, and quality/sources/replay without feed state. Expert re-read: 62 sample good/bad answers against phrase/forbid rules all judged as intended (caught 6 negation and decimal-span traps, fixed). Helpers 8/8/8.

- [x] G2: carp questions include at least: largest rise in river stage over the last 24 hours; compare two locations for tomorrow morning; why did this location start needing review; show me what we knew yesterday afternoon; which locations have stale or missing forecasts; how did the forecast issued 2 days ago compare with what happened; what is the flood category forecast for Atchafalaya sites; why do USGS and NWPS stage differ at Krotz Springs; plus boundary questions on carp abundance, expected catch, legal access and trip safety
  CHECK: bun scripts/check-questions.ts --require carp 2>&1 | tail -2
  EXPECT: /REQUIRED carp \d+\/\d+ ok/
  EVIDENCE: QUESTIONS carp=69 lionfish=65 python=68 categories=10/10 ok | REQUIRED carp 12/12 ok

- [x] G3: lionfish questions include at least: recent lionfish reports near heat-stressed reefs in Belize; compare with the previous month; why was this area highlighted; which areas have newly submitted reports of older sightings; which highlighted areas have the freshest supporting data; where are waves forecast calmer over the next three days; what do SST, anomaly, degree heating weeks, bleaching alert level, waves and currents mean for survey planning; why can degree heating weeks and the alert level disagree; which GBIF records duplicate iNaturalist; where are buoys and satellite SST disagreeing; plus boundary questions (population growth, invasion risk percent, causal reef damage, non-lionfish species, areas outside the four)
  CHECK: bun scripts/check-questions.ts --require lionfish 2>&1 | tail -2
  EXPECT: /REQUIRED lionfish \d+\/\d+ ok/
  EVIDENCE: QUESTIONS carp=69 lionfish=65 python=68 categories=10/10 ok | REQUIRED lionfish 15/15 ok

- [x] G4: python questions keep the 15 legacy golden cases (ids mapped) and add the rest across categories; boundary questions refuse non-python species and areas outside the Everglades region
  CHECK: bun scripts/check-questions.ts --require python 2>&1 | tail -2
  EXPECT: /REQUIRED python \d+\/\d+ ok/
  EVIDENCE: QUESTIONS carp=69 lionfish=65 python=68 categories=10/10 ok | REQUIRED python 18/18 ok. golden.ts actually holds 16 cases, all mapped as `py-legacy-<id>` with identical question text and `legacyId` (checker imports GOLDEN). The six tegu/iguana/lionfish legacy cases become boundary refusals (homestead-species-counts a caveat) under the per-app scope guard; Orlando and Texas refusals cover out-of-region.

- [x] G5: `docs/questions.md` is generated from the JSON by the checker (`--write`), grouped by app then category, each with intent and pass criteria; a re-run produces no diff
  CHECK: bun scripts/check-questions.ts --write >/dev/null 2>&1; git diff --quiet docs/questions.md && echo STABLE
  EXPECT: /STABLE/
  EVIDENCE: STABLE. Caveat: docs/questions.md is untracked (no commit allowed), so `git diff --quiet` passes trivially; stability checked separately: two `--write` runs gave the same sha1 183eba3a7ad1c7be026c2447c72b59c9ce90d8f3 (1070 lines, app then category, intent + tools + cites + pass per question).
