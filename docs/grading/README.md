# Grading

One command scores the whole submission against Inversa's brief (`docs/TASK_BRIEF.md`):

```sh
bun run grade
```

The criteria, weights and checks are in `docs/grading/rubric.json`, explained in `docs/grading/rubric.md`. The result goes to `docs/grading/report.md`.

## Running it

| Command | What it does |
|---|---|
| `bun run grade` | Every check: static, unit, cargo, e2e, live eval. Takes a long time and calls the real model; three eval runs per app |
| `bun run grade -- --fast` | Static and unit checks only (under a second today). Build, e2e and live checks show PENDING and earn 0 |
| `bun run grade -- --app carp` | Only carp's checks, plus the checks that cover the whole system; scores and totals are carp's |
| `bun run grade -- --only scrub-speed,data-quality` | Only these criteria |
| `bun run grade -- --timeout 600` | Default per-check timeout in seconds (a check's own `timeout` wins) |
| `bun run grade -- --no-write` | Do not write the report |
| `bun run grade -- --quiet` | Only the `GRADE`, `TOTAL` and `GRADE-RESULT` lines |
| `bun scripts/grade.ts --validate` | Check the rubric itself; prints `RUBRIC criteria=24 weight=100 ok` |
| `bun test scripts/grade.test.ts` | The grader's own tests, including that a failing, silent or timed-out check never earns points |

Live checks need Doppler access to `inversa/dev` (OpenRouter key). The deployed-URL check runs only when `GRADE_URL` is set, for example `GRADE_URL=https://inversa.calvinmaighan.dev bun run grade -- --only deploy`.

With `--only` or `--app`, `TOTAL` is the score over the selected criteria, scaled to 100.

Exit code: 0 only when every criterion meets its threshold and the total is at least 90. Otherwise 1; 2 for usage errors.

## Reading the output

Each check prints one line while it runs:

```
  CHECK scrub-speed/scrub@carp PENDING apps/web/e2e/scrub.ts does not emit "SCRUB app="
  MANUAL ui-mobile/screens-375@carp PENDING missing docs/evidence/mobile/carp-375.png
```

Then one line per criterion, then the totals:

```
GRADE push-first 3.0/3 PASS ingest-modes@carp: INGEST app=carp rows=7 push=2 poll=5 poll_justified=5 urls=7
GRADE scrub-speed 0.0/4 PENDING scrub@carp: apps/web/e2e/scrub.ts does not emit "SCRUB app="
TOTAL 13.3/100 carp=13.3 lionfish=13.3 python=13.3 pass=1 fail=2 pending=21
GRADE-RESULT FAIL
```

- **PASS**: the criterion reached its threshold. The text is the line that proved it.
- **FAIL**: a check ran and did not hold. The text says which check, which app and why (exit code, timeout, the missing line, or the number outside its bound).
- **PENDING**: nothing failed, but a check could not run yet (a missing file, script, emitter line or env var), was skipped by `--fast`, or a manual item waits for a human. It earns 0.

`docs/grading/report.md` has the same per criterion, with the score per app, then every check with its matched output lines, then a list of everything still open. Read the "Open items" list first: it is the to-do list.

## Manual items

Some things need a person. Each is worth a small share, never needed for a threshold, so automated checks alone can reach 92.1 of 100.

| Item | Evidence | Sign off |
|---|---|---|
| Deployed URL smoke: on a laptop and a phone, per app, ask a helper question, open a citation at its source, scrub the timeline | `docs/evidence/deploy-smoke.md` | `deploy/url-smoke` |
| Mobile screenshots looked at | `docs/evidence/mobile/<app>-375.png` | `ui-mobile/screens-375@<app>` |
| Desktop screenshots looked at | `docs/evidence/<app>-desktop.png` | `ui-explore/screens-desktop@<app>` |
| Selector screenshots looked at | `docs/evidence/appselect-{dark,light,mobile}.png` | `app-selector/screens` |
| Interview prep reviewed: question and sources per app | `docs/interview-notes.md` | `question-rationale/reviewed` |
| Interview prep reviewed: choices and alternatives | `docs/design-alternatives.md` | `design-alternatives/reviewed` |
| Interview prep reviewed: scaling numbers | `docs/scaling.md` | `scaling/reviewed` |
| New-technology claim is true | `docs/new-technology.md` | `new-technology/claim-true` |

To sign off, at a terminal:

```sh
bun scripts/grade.ts --confirm ui-mobile/screens-375@carp --by "Calvin"
```

It shows the item and the evidence, asks you to type `yes`, and records your name, the date and a hash of the evidence files in `docs/grading/confirmations.json`. It refuses without a terminal. If the evidence changes later, the sign-off lapses and the item is PENDING again. Agents and the overnight driver must never write `confirmations.json`.

## The overnight driver

`bun run grade` is the last gate of the overnight run (R18 in `docs/OVERNIGHT_BRIEF.md`):

1. After each wave, the driver runs `bun run grade -- --fast --no-write` (seconds) and checks that no criterion went from PASS to FAIL.
2. When a leaf lands, the driver runs `bun run grade -- --only <criteria the leaf feeds>` (see "What each later leaf must emit" in `rubric.md`) and pastes the `GRADE` lines into the leaf's gate evidence.
3. At the end, the driver runs `bun run grade` once, commits `docs/grading/report.md`, and reports the `TOTAL` line. The overnight run is done only when `GRADE-RESULT PASS` (exit 0). If it is not, the report's "Open items" list is the next round of work; items that need a person go to `docs/HUMAN_STEPS.md`.

The driver never edits `rubric.json` to make a check pass. Changing a threshold or a bound needs the user's say-so, and the commit message says what changed and why.
