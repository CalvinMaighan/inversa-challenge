# Gates: FXC carp fixes found by the judged benchmark (fable; derived from leaf-FX.md with APP=carp)

Source of truth for what failed: `docs/grading/judge-validation.md`, `docs/grading/agent-*-analysis.md`, and the J1 report. Judged pooled results on 2026-10-01 14:30Z (golden 3 runs; judge `google/gemini-3.8-flash`): carp 203/207 (98%) met=no only on category planning 15/18; lionfish 173/195 (88%) ungrounded 2; python 187/204 (91%) boundary 41/42. Repeat failures (2 of 3 runs or more) to address, each is either a real product/data gap or an agent behaviour defect, to be fixed generally (no question-specific text in prompts or tools, no answer key, no criterion loosening except a logged wrong-criterion fix with a reason):

- **Carp:** `carp-planning-rain-atchafalaya` 3/3: the NWS gridpoint adapter ingests no precipitation, so rain questions cannot be answered. Add QPF and probability of precipitation (and wind/gusts if missing) from the gridpoint forecast to the forecast snapshots and the `weather_forecast` tool, with units, issuance time and the provenance line; update fixtures (re-record live), the evidence kinds and the UI briefing if it already shows weather. `relevance-why-these-sites` flaked once.
- **Lionfish:** repeat failures `explain-colombia-hot-but-low`, `explain-highlight`, `explain-score-recipe`, `planning-fl-tomorrow`, `quality-freshest`, `relevance-nas` (tools explain_cell / evidence / sightings not called, hotspot citation missing), `planning-two-weeks` (forecast horizon never stated). Also: the marine fixture has no Florida Keys (Looe Key) point (re-record from the live Open-Meteo Marine call, check the real adapter's grid actually covers the Keys), and one real ungrounded number came from the model's own arithmetic ("20.8 days later"): make date differences come from tools (a `sinceThen`/age field) or forbid derived numbers without a tool value.
- **Python:** repeat failures `explain-activity-term`, `sources-nas-cadence` (tools skipped, source_info not cited), `replay-scores-during-cold` (stub `hotspots` ignores `asOf`, so the agent honestly cannot show movement: make the eval stub bitemporal like the API, from the cold-snap scene), `team-notes-today` (fixture has no note to cite: seed a note and a mission in the python fixture board), caveat boundary answer that did not name pythons (1 miss in 42).

Rules of the road (same as `gates/leaf-AGB.md`): blind, no answer key (`tests/server/agent/no-answer-key.test.ts` must pass), real models via Doppler, no mock. Your app only: keep changes in your app's files or clearly app-scoped blocks; touch shared files (`prompt.ts` shared rules, `answer-check.ts`, `run-turn.ts`, `eval/**`) only for a general defect and say so in the report; the other two FX agents work concurrently in sibling worktrees. Do NOT change the judge, the corpus, `rubric.*`, `scripts/grade.ts`. Fixtures that the stub servers use may be improved only to match what the real API/adapters return. Work in the worktree the driver created for you; commit there; never push; `cd`/`git -C` only inside it. macOS has no `timeout`. Budget about $8 of live runs per agent.

- [ ] G1: every defect listed for your app has a root cause and a general fix recorded in `docs/grading/agent-<app>-analysis.md` ("Judged benchmark round" section): which were real data/product gaps (and the fix with its test), which agent behaviour (the general prompt/tool change and why it generalises), which wrong criteria (logged in the question file's changelog with reason); web tests, typecheck, lint, api tests (if api touched) and clippy clean
  CHECK: bun run check 2>&1 | tail -2
  EXPECT: /CHECK-OK/
  EVIDENCE: pending

- [ ] G2: golden set, `--runs 3` on final code for your app: quote the full pooled summary with timestamp and each run's failed ids; the pooled bars line must say `met=yes` (overall >= 95% pooled, every non-boundary category >= 90% pooled, boundary 100% per run, ungrounded 0 per run). If after a disciplined effort the bars cannot be met, do not weaken anything: mark ABANDON with the exact residual failures, their root causes and your assessment, and what you would do next
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run eval/run.ts --app carp --runs 3 2>&1 | grep -E "^EVAL pooled (bars|ungrounded|passed)"
  EXPECT: /EVAL pooled ungrounded=0[\s\S]*met=yes/
  EVIDENCE: pending

- [ ] G3: holdout, `--holdout --runs 2`: pooled at least 90% overall, boundary 100%, ungrounded 0 (the holdout files are not edited after seeing results except logged wrong-criterion fixes)
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run eval/run.ts --app carp --holdout --runs 2 2>&1 | grep -E "^EVAL pooled (bars|ungrounded|passed)"
  EXPECT: /EVAL pooled ungrounded=0[\s\S]*met=yes/
  EVIDENCE: pending

- [ ] G4: for carp (FXC only): `e2e:carp` and `e2e:agent --app carp` still pass and the briefing/tool show precipitation with units; for lionfish (FXL only): `e2e:lionfish`, `e2e:agent --app lionfish` pass; for python (FXP only): `e2e:agent --app python`, `e2e:species`, `e2e:notes` pass; quote the OK lines
  EVIDENCE: pending
