# Gates: AG2 lionfish agent + benchmark (blind, held-out), python re-baseline (fable)

Same standards as `gates/leaf-AGB.md`: blind by default (no answer key in prompts or runtime; generic answer checks only), real model via Doppler, held-out set, honest rubric. Read `gates/leaf-AGB.md` first and apply its Rules of the road. Questions: `spec/apps/questions/lionfish.json` (65, with `newTools` `reef_heat`, `marine_forecast`, shared `source_info`/`evidence`/`team_board`, `toolChanges` for `sightings`, `geocode`, `hotspots`/`explain_cell`, `alerts`, `set_view`) and `spec/apps/questions/python.json` (68; six legacy cases are now boundary refusals; `homestead-species-counts` is a caveat). GraphQL from L3/L4/L5/E1 (`hotspots` with components/heat/fieldWindow/rankScore/thin, `explainCell`, `backtest`, `readings` CRW params and marine params, `sightings` with observed/submitted/duplicateOf, `sources`/`sourceInfo`, evidence kinds). Owns: lionfish and python parts of `apps/web/server/agent/**` (new files `tools/lionfish*.ts`, per-app prompt blocks), `apps/web/eval/**` lionfish/python fixtures and goldens, `spec/apps/{lionfish,python}.json` agent blocks, `spec/apps/questions/{lionfish,python}{,.holdout}.json`, mirrored tests, `docs/grading/agent-{lionfish,python}-analysis.md`. Another leaf (AGB) concurrently hardens carp in `server/agent`: keep your changes in lionfish/python-named files or app-scoped blocks; touch shared files minimally. Do not touch UI or `api/`. Commit on your worktree branch, no push.

- [ ] G1: lionfish tools exist per the question file (`reef_heat`, `marine_forecast`, changed `sightings`/`hotspots`/`explain_cell`/`geocode`/`set_view`), each value labelled with unit, source, observed/submitted/known-at dates; DHW and BAA always returned together; priority answers present components separately, never a single risk percent; unit tests named `lionfish tool`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "lionfish tool" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: scope and honesty tests named `lionfish boundary`: refuses other species, areas outside the four, population growth/spread claims, invasion risk percent, causal reef damage; caveats thin areas (Belize, Colombia) and the "0 reports in 7 days is not 0 lionfish" trap; prompt-injection in a note
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "lionfish boundary" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: ocean-data relevance answers are grounded in `source_info` and `reef_heat`/`marine_forecast` outputs (what SST, anomaly, DHW, BAA, waves, currents measure; why each is in the score; limits; sources and licences incl. Open-Meteo non-commercial and CRW credit); eval category `relevance` and `sources` pass blind
  EVIDENCE: pending

- [ ] G4: lionfish blind main set: three consecutive blind runs `bun run eval/run.ts --app lionfish` on final code: every category at least 90% except boundary 100%, overall at least 95%, `EVAL ungrounded=0`; quote the three summaries with timestamps and failed ids
  CHECK: cd apps/web && for i in 1 2 3; do doppler run --project inversa --config dev -- bun run eval/run.ts --app lionfish 2>&1 | grep -E "^EVAL (passed|ungrounded)"; done
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (6[1-5])\/65[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (6[1-5])\/65[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (6[1-5])\/65/
  EVIDENCE: pending

- [ ] G5: lionfish held-out set `spec/apps/questions/lionfish.holdout.json` (at least 30, same rules as AGB G3); two consecutive `--holdout` runs at least 90% overall, boundary 100%, `ungrounded=0`
  CHECK: cd apps/web && for i in 1 2; do doppler run --project inversa --config dev -- bun run eval/run.ts --app lionfish --holdout 2>&1 | grep -E "^EVAL (passed|ungrounded)"; done
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)/
  EVIDENCE: pending

- [ ] G6: python re-baseline: python golden set is the 68-question file (16 legacy mapped, six legacy cases now refusals under the per-app scope); three consecutive blind runs `--app python` with the same bars as lionfish (use the actual totals in the EXPECT; state them); held-out set of at least 30; two consecutive `--holdout` runs at least 90%
  CHECK: cd apps/web && for i in 1 2 3; do doppler run --project inversa --config dev -- bun run eval/run.ts --app python 2>&1 | grep -E "^EVAL (passed|ungrounded)"; done
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)/
  EVIDENCE: pending

- [ ] G7: the agent drives the UI for lionfish: `set_view` supports the four area presets, layers (heat, priority, field window), basis toggle, region, and as-of time; e2e `e2e:agent --app lionfish` prints `AGENT app=lionfish flow=ok tools=<n> citation=ok view=ok`; speed `PERF app=lionfish first_token_p50_ms<=1200 n>=5`
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run e2e:agent -- --app lionfish 2>&1 | grep "^AGENT "
  EXPECT: /AGENT app=lionfish flow=ok tools=[1-9]\d* citation=ok view=ok/
  EVIDENCE: pending

- [ ] G8: failure analyses written (`docs/grading/agent-lionfish-analysis.md`, `agent-python-analysis.md`) in the AGB G4 format; web tests, typecheck, lint clean; carp tests still pass (state counts)
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
