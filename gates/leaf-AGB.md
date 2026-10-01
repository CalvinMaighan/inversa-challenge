# Gates: AGB carp blind benchmark hardening + held-out set (fable)

Finding (driver, 2026-10-01): the carp benchmark passed 69/69 only because the agent is handed the golden question's tools, wording and citations (`questionHint`) and a pre-stream answer check against the golden pass criteria (`run-turn.ts`, `answer-check.ts`). The eval is now blind by default (`AGENT_BLIND=1`, `--assisted` opts into hints): blind runs scored 62-65/69. A benchmark that is told its answers measures nothing. Your job is to make the agent actually good blind, and to add a held-out set the prompts never saw.

Owns: `apps/web/server/agent/**` (carp prompt, tools, answer-check, scope), `apps/web/eval/**`, `spec/apps/questions/carp.json` (fix wrong criteria only with a written reason), new `spec/apps/questions/carp.holdout.json`, `docs/grading/rubric.{json,md}` eval criteria, `scripts/check-questions.ts` (holdout schema), mirrored tests. Do not touch UI or `api/`. Real model via Doppler; no mock. Commit on your worktree branch, no push. Another leaf (AG2) concurrently adds lionfish agent parts: keep carp changes in carp-named files or clearly carp-scoped blocks; touch shared files minimally.

Rules of the road: no golden question text, id or `pass` phrase may appear in any prompt or tool description; production hints (`questionHint`, `matchSupportedQuestion` in the runtime) are removed from the answering path or limited to starter-chip routing that does NOT inject expected tools, wording or citations; the runtime answer check may only use generic checks (numbers trace to tool output, feed-state disclosure for stale/missing data, boundary refusals by category) never the golden phrases.

- [ ] G1: blind main set: three consecutive blind runs (`bun run eval/run.ts --app carp`, default blind) on final code, each with every category at least 90% except `boundary` 100%, overall at least 95%, `EVAL ungrounded=0`, views valid; quote the three EVAL summaries with timestamps and the list of failed ids per run (and what you changed because of them)
  CHECK: cd apps/web && for i in 1 2 3; do doppler run --project inversa --config dev -- bun run eval/run.ts --app carp 2>&1 | grep -E "^EVAL (passed|ungrounded)"; done
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (6[6-9])\/69[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (6[6-9])\/69[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (6[6-9])\/69/
  EVIDENCE: pending

- [ ] G2: no answer key leaks: a test scans every prompt/tool-description string the agent can see for golden question ids and `pass.phrases` fragments (from the question files) and fails on a match; `AGENT_BLIND` handling is removed in favour of the blind path being the only path (the `--assisted` flag may stay only for the starter-chip routing check); test named `no answer key`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "no answer key" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: held-out set: `spec/apps/questions/carp.holdout.json` has at least 30 questions never used in tuning: paraphrases of golden questions (different words, order, typos, casual phrasing) and at least 10 new questions across the 10 categories, each with expectations in the same schema; created BEFORE the final tuning runs and not edited after seeing results except to fix a genuinely wrong criterion (log each such edit in the file's `changelog`); `bun run eval/run.ts --app carp --holdout` prints the same EVAL lines; two consecutive runs at least 90% overall, boundary 100%, `ungrounded=0`
  CHECK: cd apps/web && for i in 1 2; do doppler run --project inversa --config dev -- bun run eval/run.ts --app carp --holdout 2>&1 | grep -E "^EVAL (passed|ungrounded)"; done
  EXPECT: /EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)[\s\S]*EVAL ungrounded=0[\s\S]*EVAL passed (\d+)\/(\d+)/
  EVIDENCE: pending

- [ ] G4: failure analysis written to `docs/grading/agent-carp-analysis.md`: for each failure seen across blind and holdout runs, the question, what the agent did, why (prompt, tool shape, missing data, model variance), the fix and whether the fix is general (not question-specific); plus honest residual failure rate
  EVIDENCE: pending

- [ ] G5: speed and cost: `PERF app=carp first_token_p50_ms` at most 1200 with n >= 5; cost per full blind run stated; prompt caching on system and tool definitions verified (cache-read tokens dominate)
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun run e2e:perf -- --app carp 2>&1 | grep "^PERF "
  EXPECT: /PERF app=carp first_token_p50_ms=([0-9]{1,3}|1[01][0-9]{2}|1200) n=([5-9]|[1-9][0-9]) cached_query_ms=\d/
  EVIDENCE: pending

- [ ] G6: rubric updated honestly: `docs/grading/rubric.json` agent-benchmark and agent-grounding criteria use the blind default and the held-out set with the bars above (per-category 90%, boundary 100%, overall 95%, ungrounded 0, three consecutive runs) and `rubric.md` explains why variance makes 100% the wrong bar for a stochastic model while boundary and grounding stay strict; `bun scripts/grade.ts --validate` passes; web tests, typecheck, lint clean
  CHECK: bun scripts/grade.ts --validate 2>&1 | tail -1 && bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /RUBRIC criteria=\d+ weight=100 ok[\s\S]*0 fail[\s\S]*CLEAN/
  EVIDENCE: pending
