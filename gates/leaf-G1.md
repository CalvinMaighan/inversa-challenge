# Gates: G1 grading system (opus)

Owns: `docs/grading/rubric.md`, `docs/grading/rubric.json`, `scripts/grade.ts`, the `grade` script line in the root `package.json`, `docs/grading/README.md`. Do not edit other files. Do not commit.

Intent: one command, `bun run grade`, scores the whole submission against `docs/TASK_BRIEF.md`. It must be honest: criteria whose checks do not exist yet score 0 and print `PENDING <id> <what is missing>`; it never invents a pass. Later leaves (agent evals, e2e, perf, a11y, data quality, live URL smoke) plug in by satisfying the check commands you declare. Weighted criteria come from the brief: technical requirements (3+ real-time feeds around one question; backend collect/store/query; NL web interface across real-time and historical; interactive timeline with replay), deliverables (new technology; deployed shared URL), what we look for (system design and data modeling; production agent grounded answers; responsive human-friendly UI; fast interactions and smooth scrubbing; data handling of stale/missing/conflicting data), and be-prepared items (question rationale; design choices and alternatives; scaling story). Plus our additions: three apps work, app selector, push-first ingest, real-time DM and notes, only three species. Evaluate every criterion per app where it applies (carp, lionfish, python).

- [ ] G1: `docs/grading/rubric.json` lists criteria with `id`, `brief` (the brief sentence it maps to, quoted briefly), `weight` (weights sum to 100), `appliesTo` (apps), `threshold`, `checks` (runnable commands with an expected output regex and a points share) and `manual` (evidence files or doc paths that must exist and the item a human must confirm); `docs/grading/rubric.md` explains each in plain words
  CHECK: bun scripts/grade.ts --validate 2>&1 | tail -3
  EXPECT: /RUBRIC criteria=\d+ weight=100 ok/
  EVIDENCE: pending

- [ ] G2: `bun run grade` runs all checks (with a per-check timeout, `--only <id>`, `--app <id>`, `--fast` to skip live/e2e), prints one line per criterion `GRADE <id> <score>/<weight> <PASS|FAIL|PENDING> <evidence path or reason>`, writes `docs/grading/report.md` with totals per app and overall, and exits non-zero unless every criterion meets its threshold and the total is at least 90
  CHECK: bun scripts/grade.ts --fast --no-write 2>&1 | grep -c "^GRADE "
  EXPECT: /^([2-9][0-9]|[1-9][0-9][0-9])$/
  EVIDENCE: pending

- [ ] G3: honesty: on the current tree a criterion with a missing check prints PENDING and scores 0; a unit test proves a fake pass is impossible (a check whose command fails, times out or prints nothing never earns points); test file `scripts/grade.test.ts`
  CHECK: bun test scripts/grade.test.ts 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G4: the agent benchmark criteria call `bun run eval -- --app <id>` and parse its `EVAL passed P/T` and per-category lines; they require every category to pass and no ungrounded numbers; the rubric states the live-eval requirement (real OpenRouter calls via Doppler `inversa/dev`, no mock agent) and how runs are repeated (3 consecutive passes)
  EVIDENCE: pending

- [ ] G5: `docs/grading/README.md` shows how to run it, how to read the report, how the overnight driver uses it as the final gate, and lists the manual items needing a human (deployed URL smoke, screenshots looked at, interview-prep doc reviewed)
  EVIDENCE: pending
