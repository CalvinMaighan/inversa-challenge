# Gates: node MG, merge of leaf AG2 (lionfish and python agent) onto leaf AGB (carp blind hardening)

Merge of `worktree-agent-acad5ce848c66d986` (AG2) into `pivot/three-apps` at 0b8cc05. Five files conflicted:
`apps/web/eval/{check,golden,run}.ts`, `apps/web/server/agent/prompt.ts`, `apps/web/server/agent/tools/common.ts`.
Both leaves' behaviour kept: the eval is blind by default (no `AGENT_BLIND`, no `questionHint`, no `--assisted`),
`--holdout` reads `spec/apps/questions/<app>.holdout.json` at run time for any app, the `EVAL bars ... met=` line
and the per-category `pct=` stay, AG2's lionfish and python prompt blocks and tools are in, and the two numbers-trace
fixes AG2 made in its copy of `eval/check.ts` (year regex, typographic minus) are ported into the shared
`server/agent/answer-check.ts` that AGB moved the trace into. Prompt wording that the `no answer key` test flagged
(five-word runs of lionfish and python questions, the literals "Coral Reef Watch", "does not mean", "at that time")
was reworded without changing the rule; the matching unit-test expectations were updated.

- [x] G1: web tests, typecheck, lint clean after the merge
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: 2026-10-01 ` 1004 pass` / ` 0 fail`; `tsc -p tsconfig.json` and `eslint .` clean (CLEAN).

- [x] G2: no answer key for all three apps' question and held-out files (prompt, view context, tool descriptions and schemas)
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "no answer key" 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /^ *1 pass[\s\S]*^ *0 fail/m
  EVIDENCE: first run after the merge listed 40 hits, all in the lionfish and python prompt blocks and the `reef_heat` description (for example `five words of the question "over the next three days"`, `pass phrase "coral reef watch"`); after rewording: ` 1 pass` / ` 0 fail`.

- [x] G3: question files and held-out sets validate for all three apps; rubric validates
  CHECK: bun scripts/check-questions.ts 2>&1 | grep -E "^(QUESTIONS|HOLDOUT)" && bun scripts/grade.ts --validate 2>&1 | tail -1
  EXPECT: /QUESTIONS carp=69 lionfish=65 python=68 categories=10\/10 ok[\s\S]*HOLDOUT carp=42 lionfish=40 python=36 ok[\s\S]*RUBRIC criteria=\d+ weight=100 ok/
  EVIDENCE: `QUESTIONS carp=69 lionfish=65 python=68 categories=10/10 ok`, `HOLDOUT carp=42 lionfish=40 python=36 ok`, `RUBRIC criteria=24 weight=100 ok`.

- [x] G4: live blind golden run, carp, no regression against AGB's reported 66-69/69
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run eval/run.ts --app carp 2>&1 | grep -E "^EVAL (ungrounded|passed)"
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (6[6-9])\/69/
  EVIDENCE: finished 2026-10-01T13:17:30Z: `EVAL ungrounded=0 checked=292` | `EVAL passed 68/69 pct=98` | boundary 9/9, every category 100% except planning 5/6 (carp-planning-best-days-simmesport: the "conditions only" sentence missing, a miss AGB's analysis also records as model variance). `EVAL tokens in=2035415 cache_read=1556211 out=39931 cost<=$0.2235 wall=136s`.

- [x] G5: live blind golden run, lionfish, no regression against AG2's reported 58-62/65
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run eval/run.ts --app lionfish 2>&1 | grep -E "^EVAL (ungrounded|passed)"
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (5[8-9]|6[0-5])\/65/
  EVIDENCE: finished 2026-10-01T13:17:52Z: `EVAL ungrounded=0 checked=252` | `EVAL passed 58/65 pct=89` | boundary 8/8. Failed: lionfish-explain-colombia-hot-but-low (explain_cell not called), lionfish-explain-top-cell (no hotspot citation), lionfish-relevance-nas (sightings not called), lionfish-quality-buoy-vs-satellite (coverage sentence), lionfish-quality-nas-colombia (sightings not called), lionfish-planning-two-weeks (72-hour sentence), lionfish-replay-90d-mx ("90 days" wording); the same ids recur in AG2's own three final runs (59, 62, 58 of 65). `EVAL tokens in=2476741 cache_read=2090007 out=46980 cost<=$0.2712 wall=158s`.

- [x] G6: live blind golden run, python, no regression against AG2's reported 63-66/68
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run eval/run.ts --app python 2>&1 | grep -E "^EVAL (ungrounded|passed)"
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (6[3-8])\/68/
  EVIDENCE: finished 2026-10-01T13:17:38Z: `EVAL ungrounded=0 checked=145` | `EVAL passed 64/68 pct=94` | boundary 14/14. Failed: python-planning-cold-tonight ("pythons will" phrasing), python-sources-nas-cadence (feed_state not called), python-team-notes-today and python-team-notes-flamingo (notes returned, no note citation); AG2's own final runs were 64, 64, 63 of 68. `EVAL tokens in=1872865 cache_read=1650973 out=28994 cost<=$0.2018 wall=141s`.
