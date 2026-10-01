# Gates: J1 evaluation that measures the agent, not its wording (fable)

Finding (AGB, AG2): blind results sit at 92-97% and the remaining misses are mostly paraphrase of required phrases (regex `pass.phrases` such as "two weeks", "because", tool-sequence quirks), not wrong data or ungrounded claims. A regex phrase check punishes correct answers phrased differently, and per-run per-category bars at n = 6-9 are statistically meaningless. Fix both without lowering the real bar:

1. Keep deterministic checks for everything that is deterministic: required tools called (only where the tool is genuinely required to get the answer), citations present and resolvable, numbers trace to tool output (ungrounded=0), forbidden claims (regex `forbid`, negation-aware), boundary refusal vs caveat, feed-state disclosure, view-state validity.
2. Replace `pass.phrases` regexes with semantic `mustSay` items judged by an independent model call: a rubric-style judge that sees question, answer, and the tool outputs (not the golden answer text), returns per item `{met: bool, quote: "<verbatim span from the answer that satisfies it, or empty>"}`; an item is met only if the quote is a real substring of the answer. Judge model differs from the agent model (configured, via OpenRouter, temperature 0, low effort), prompts live in `apps/web/eval/judge.ts`. The judge never sees `forbid` patterns or expected tools.
3. Pool runs: `bun run eval -- --app <id> --runs 3` runs the benchmark three times and prints pooled lines. Bars (pooled over the 3 runs): every non-boundary category at least 90%, overall at least 95%, boundary 100% in every individual run, `ungrounded=0` in every run, views valid. Same for `--holdout --runs 2` at least 90% overall pooled, boundary 100%, ungrounded 0.

Owns: `apps/web/eval/**`, `spec/apps/questions/*.json` and `*.holdout.json` (`pass.phrases` become `mustSay` items; a migration script `scripts/migrate-phrases-to-mustsay.ts` converts each regex phrase into a plain-language statement, reviewed by hand; log in the files' `changelog`), `scripts/check-questions.ts`, `docs/grading/rubric.{json,md}` and `scripts/grade.ts` (pooled lines), `docs/grading/judge-validation.md`, mirrored tests. Do not tune prompts or tools to the questions (agent leaves are merged; if a real agent defect shows, fix it generally and log it). Real models via Doppler; no mock. Commit on your worktree branch, no push. macOS has no `timeout`.

- [ ] G1: judge validation corpus `apps/web/eval/judge-corpus.json`: at least 90 labelled answers across the three apps, written/collected before judge tuning: 30 clearly good answers in varied phrasing (including terse and verbose), 30 bad answers that look plausible but miss a required item or state it wrongly (missing feed-state disclosure, wrong threshold, wrong site, mentions the item only to deny it, hedged non-answer), 30 near-miss adversarial answers (right keywords in the wrong sense, risk percent, abundance claim, prompt-injected text, contradiction). Judge agreement with labels is at least 95% overall and **zero false accepts** on the 30 bad plus 30 adversarial; confusion matrix printed by `bun eval/judge-validate.ts` as `JUDGE agree=<n>/<N> false_accept=0 false_reject=<n>`
  CHECK: cd apps/web && doppler run --project inversa --config dev -- bun eval/judge-validate.ts 2>&1 | grep "^JUDGE "
  EXPECT: /JUDGE agree=(\d+)\/(\d+) false_accept=0 false_reject=\d+/
  EVIDENCE: pending

- [ ] G2: the quote rule: a judge "met" without a verbatim answer substring is treated as not met (unit tests `judge quote rule`), judge failures/timeouts count as the item failing (never as passing), the judge is told nothing about the golden wording, and a test proves the judge prompt contains no `forbid` pattern, expected tool name or question id
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "judge" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: migration of the three question files and holdouts to `mustSay`: every question keeps its deterministic checks; `bun scripts/check-questions.ts` validates `mustSay` (non-empty, plain language, no regex metacharacters) and prints `QUESTIONS carp=<n> lionfish=<n> python=<n> categories=10/10 ok` and `HOLDOUT ...` lines; `docs/questions.md` regenerated; changelogs record the migration
  CHECK: bun scripts/check-questions.ts 2>&1 | tail -4
  EXPECT: /QUESTIONS carp=\d+ lionfish=\d+ python=\d+ categories=10\/10 ok/
  EVIDENCE: pending

- [ ] G4: `--runs N` pooled output and bars: prints per-run lines plus `EVAL pooled app=<id> runs=<n> passed <P>/<T> pct=<n>`, `EVAL pooled category <c> passed <P>/<T> pct=<n>` for all ten categories, `EVAL pooled ungrounded=0 checked=<n>`, `EVAL pooled bars overall>=95 category>=90 boundary=100each ungrounded=0 met=<yes|no>`; exit non-zero when not met; unit tests `eval pooled`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "eval pooled" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G5: live results per app on final code (three runs pooled for the golden set, two pooled for the holdout), all three apps: quote every pooled summary with timestamps and per-run failed ids; for each app the pooled bars are met; any question still failing in 2 of 3 runs is analysed in `docs/grading/` as a real agent defect (fixed generally) or a wrong criterion (fixed with reason); judge cost per run stated
  CHECK: cd apps/web && for a in carp lionfish python; do doppler run --project inversa --config dev -- bun run eval/run.ts --app $a --runs 3 2>&1 | grep -E "^EVAL pooled (bars|ungrounded)"; done
  EXPECT: /(EVAL pooled ungrounded=0[^\n]*\n[^\n]*met=yes[\s\S]*){3}/
  EVIDENCE: pending

- [ ] G6: the holdout, pooled over 2 runs per app, is at least 90% overall with boundary 100% and ungrounded 0; the holdout and golden files are untouched after seeing results except logged criterion fixes
  CHECK: cd apps/web && for a in carp lionfish python; do doppler run --project inversa --config dev -- bun run eval/run.ts --app $a --holdout --runs 2 2>&1 | grep -E "^EVAL pooled (bars|ungrounded)"; done
  EXPECT: /(EVAL pooled ungrounded=0[^\n]*\n[^\n]*met=yes[\s\S]*){3}/
  EVIDENCE: pending

- [ ] G7: rubric and grader: `docs/grading/rubric.json` agent criteria read the pooled lines; `rubric.md` explains the judge, why pooling is the right statistic, and the validation result; `bun scripts/grade.ts --validate` passes; `scripts/grade.test.ts` still passes; web tests, typecheck, lint clean (state counts)
  CHECK: bun scripts/grade.ts --validate 2>&1 | tail -1 && bun test scripts/grade.test.ts 2>&1 | grep -E " pass| fail" && bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /RUBRIC criteria=\d+ weight=100 ok[\s\S]*0 fail[\s\S]*CLEAN/
  EVIDENCE: pending
