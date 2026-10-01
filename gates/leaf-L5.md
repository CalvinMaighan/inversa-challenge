# Gates: L5 lionfish survey-priority score (fable)

Contract: PLAN.md P3 (honesty: components shown separately, no single risk percent, sightings are not abundance, heat stress is context, field conditions separate from ecological priority); `docs/LIONFISH_WATCH.md`; data shapes from L3 (CRW params `sst,sst_anomaly,dhw,baa` per 5 km cell, `observed_at` = product day 12:00Z; DHW and BAA can disagree and both are shown) and L4 (`quality_bio::area_summary`, `INDEPENDENT_SQL`, `CORROBORATED_SQL`, `marine_forecasts` table, observed vs submitted dates, GBIF copies of iNat never count as corroboration). You own: `api/src/hotspot/**` (score, rules, backtest, explain), `api/src/graphql/**` hotspot types and resolvers, `api/schema.graphql` hotspot parts, `spec/apps/lionfish.json` score block. Python's hotspot behaviour stays unchanged (its tests must keep passing). Do not touch web. Commit on your worktree branch, no push.

Design (decided): the lionfish priority per grid cell has four separate components, each in [0,1] with its own explanation and inputs, and a configurable weighted sum is used only to rank (`rankScore`), never presented as a probability or risk percent:
1. `recentReports`: kernel-weighted independent sightings (observed date, 60-day half-life), research-grade weighted higher; NAS and GBIF history count as a 0.2 prior; duplicates never double-count.
2. `idQuality`: share of recent reports that are research grade with accuracy under the cell size; unknown when no reports.
3. `heatStress`: from CRW at the cell: DHW (accumulated) and BAA (alert level) mapped separately, combined by max with both values returned; unknown when CRW is missing or stale beyond 72 h.
4. `completeness`: how much of the evidence is present and fresh (reports lag, CRW age, coverage of NAS/buoy for the region, thin-region flag); low completeness lowers confidence, not priority.
Field conditions (`fieldWindow`: waves under a threshold, current, from `marine_forecasts` over 72 h) are returned as a separate object per cell and never enter `rankScore`.

- [ ] G1: component functions are pure and unit-tested with the Florida-like case (DHW 13.65, BAA 1), the Belize thin case (1 report in 90 days), GBIF copy of an iNat record (no double count), missing CRW (heatStress unknown, not 0), stale CRW (flagged), no reports with high heat (priority from heat only, completeness low); test names `lionfish_score_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_score_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: GraphQL `hotspots(species, at, bbox, top, region)` for lionfish returns cells with `components {recentReports idQuality heatStress completeness}` each `{value, state: ok|unknown|stale, inputs[]}`, `heat {dhw baa sst anomaly observedAt}`, `rankScore`, `fieldWindow {...}`, `regionId`; the type has no field named risk, probability or percent; a schema test asserts that; weights come from the config and a `weights` argument can override them per query; test names `lionfish_hotspots_graphql`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_hotspots_graphql 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: `explainCell` returns, per component, the exact observation ids (sightings with observed and submitted dates and photo links), CRW cell values with product date and credit, timestamps, ingest times, source links and the honesty caveats (sightings are not abundance; heat stress is context; no causal claim); evidence ids stay `hotspot:lionfish:<region>:<col>:<row>:<ms>`; test names `lionfish_explain_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_explain_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: backtest for lionfish: would the ranking at `t-7d` have placed cells that received independent reports in the following 7 days in the top 10 percent; result reports hit rate versus a baseline of random cells and states plainly that reports reflect observer effort; thin regions are reported as insufficient data, not scored; test names `lionfish_backtest_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_backtest_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: replay: the hotspot for time `t` uses only data known at `t` (sightings by `submitted_at <= t` unless the query asks for observed-date basis, CRW by product date and ingest time); two timestamps give different grids; frames for lionfish carry the ranked grid per region; test names `lionfish_asof_`
  CHECK: cargo test --manifest-path api/Cargo.toml lionfish_asof_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: on fixture data (`backfill --fixtures --app lionfish`) the top cells per region are printed and sane: Florida Keys and Mexican Caribbean have ranked cells whose top cell has reports; Belize and Colombia are marked thin; prints `LIONFISH-TOP fl=<cell> mx=<cell> bz=thin co=thin` (cell ids real)
  CHECK: INVERSA_DATA_DIR=$(mktemp -d) cargo test --manifest-path api/Cargo.toml lionfish_top -- --nocapture 2>&1 | grep LIONFISH-TOP
  EXPECT: /LIONFISH-TOP fl=\S+ mx=\S+ bz=thin co=thin/
  EVIDENCE: pending

- [ ] G7: python hotspot tests unchanged and passing; full api suite and clippy clean (state counts and any python test touched)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: pending
