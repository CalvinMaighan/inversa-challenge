# Grading rubric

`bun run grade` scores the submission against `docs/TASK_BRIEF.md`. The machine-readable rubric is `docs/grading/rubric.json`; this page says the same in plain words. How to run it and read the report: `docs/grading/README.md`.

## Rules

- 24 criteria, weights sum to 100. Each one quotes the line it comes from: in `docs/TASK_BRIEF.md`, in `docs/OVERNIGHT_BRIEF.md` §8 (our R14 to R18), or in `docs/APPS.md`. `--validate` checks that each quote appears verbatim.
- Every criterion applies to all three apps: carp, lionfish, python. A check whose command contains `{app}` runs once per app and each run is worth a third of that check's share. Checks without `{app}` cover the whole system and count for every app.
- A check earns its share only when its command exits 0, prints something, finishes inside its timeout and every expected line is there with numbers inside their bounds. Missing output, a failing command and a timeout all earn 0. A check with `repeat: 3` must pass three runs in a row.
- A check whose prerequisites are missing (a file, a `package.json` script, an emitter that does not print its result line yet, an env var) is **PENDING** and earns 0. `--fast` skips build, e2e and live checks; they show as PENDING and earn 0.
- Manual items earn points only after a human signs off with `bun scripts/grade.ts --confirm <criterion>/<item>[@app] --by <name>` at a terminal. The sign-off stores a hash of the evidence files; if they change, the sign-off lapses.
- Pass bar: every criterion at or above its threshold, and a total of at least 90. Thresholds never need a human or the live URL: automated checks alone can reach 92.1. The last 7.9 points are the manual items and the deployed-URL smoke.
- `--validate` rejects a rubric where any expected pattern matches empty output, where a check could be satisfied by generic output such as `ok` or `1 pass / 0 fail`, where a bound names a group the pattern does not capture, or where shares do not sum to 1.

## Criteria

Kinds: static (file and grep checks, seconds), unit (bun tests, seconds), build (cargo, lint, typecheck, minutes), e2e (Playwright on the real stack), live (real network or the real model through Doppler `inversa/dev`).

### Technical requirements (23)

| Id | Weight | Threshold | In plain words | How it is checked |
|---|---|---|---|---|
| `feeds-realtime` | 6 | all | Each app has a question and at least three real-time feeds from different sources, and they fetch live data | Config probe: `question=1`, at least 3 distinct `feeds[].source` in `spec/apps/{app}.json` (0.4). Live: `e2e:feeds --app` prints `FEEDS app=<id> fetched>=3 failed=0 records>=1` (0.6) |
| `backend` | 6 | all | One Rust API collects, stores and queries every feed, with one isolated store per app | `cargo test`: at least 200 tests ok, `e2e_fixture_pipeline` ok, no failed binary (0.4); `app_isolation`, `app_routes`, `app_scheduler` tests ok (0.6) |
| `nl-query` | 5 | all | You can ask in plain English about now and about the past, per app | `e2e:agent --app` prints `AGENT app=<id> flow=ok tools>=1 citation=ok` (0.4); live eval categories `lookup`, `change`, `replay` all pass, three runs in a row (0.6) |
| `timeline-replay` | 6 | all | The timeline plays, steps and shows what was known at a past time | `e2e:replay --app` prints `REPLAY app=<id> play=ok step=ok asof=ok frames>=24 errors=0` (0.6); the scrub run covers at least 48 frames with 0 requests (0.4) |

### Deliverables (9)

| Id | Weight | Threshold | In plain words | How it is checked |
|---|---|---|---|---|
| `new-technology` | 3 | 0.8 | A meaningful part uses technology new to the author, said plainly and proven by tests | `docs/new-technology.md`: 250+ words, says "new to me", names code paths, says why and what was learned (0.4); CRDT vectors pass in the TS runner, at least 14 (0.4); human: the claim is true (0.2) |
| `deploy` | 6 | 0.5 | Ready to deploy now; live at the shared URL once a human deploys (R19) | `e2e:prod --app` prints `PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok` after a production build (0.35); `docs/HUMAN_STEPS.md` names the deploy, the domain, secrets and push, and the deploy files exist (0.15); with `GRADE_URL` set: `/health` lists the app and `/?app=<id>` answers 200 (0.3); human smoke on laptop and phone (0.2) |

### What they are looking for (47)

| Id | Weight | Threshold | In plain words | How it is checked |
|---|---|---|---|---|
| `system-design` | 5 | all | One config contract read by both Rust and TS; types and lint clean | `bun test -t "app config"` passes (0.3); cargo `app_config` (2+) and schema tests ok (0.3); lint clean (0.2); typecheck clean (0.2) |
| `agent-benchmark` | 10 | all | The live agent passes every question category for every app, three runs in a row | `bun run eval -- --app <id>` three times: `EVAL app=<id> model=openai/gpt-6-luna questions>=48`; for each of the 10 categories `EVAL category <c> passed P/P` with at least 3 questions; `EVAL passed P/P` with at least 48 |
| `agent-grounding` | 4 | all | Numbers come from tool output, citations are checked, only the real model is used | Grep finds no stand-in model code (0.2); the citation filter unit tests pass (0.2); eval prints `EVAL ungrounded=0 checked>=20` and `boundary`, `sources` pass, three runs (0.6) |
| `evidence-source` | 4 | all | From an answer or a map item you reach the record, its raw payload and the publisher's page | `e2e:evidence --app` prints `EVIDENCE app=<id> citation=ok drawer=ok raw=ok source_link=ok new_tab=ok sources>=3` (0.6); `e2e:links --app`: every external link opens in a new tab, none unsafe (0.2); cargo `source_page_url` tests, at least 10 (0.2) |
| `ui-accessibility` | 4 | all | No serious or critical axe violations; everything works by keyboard | `e2e:a11y --app` prints `AXE app=<id> serious=0 critical=0 scans>=4` and `KEYBOARD-OK app=<id>` |
| `ui-mobile` | 3 | 0.8 | Usable at 375 px wide | `e2e:layout --app`: `LAYOUT app=<id> ... mobile=ok` and `MOBILE app=<id> overflow=0 hscroll=0` (0.8); human looks at `docs/evidence/mobile/<id>-375.png` (0.2) |
| `ui-explore` | 3 | 0.8 | Legend, tooltips and agent result panels make the data readable | `LAYOUT app=<id> ... legend=ok ... tooltip=ok` (0.4); `e2e:panels --app` prints `PANELS app=<id> table>=1 series>=1 ... drawer=1` (0.4); human looks at `docs/evidence/<id>-desktop.png` (0.2) |
| `scrub-speed` | 4 | all | Scrubbing the timeline feels instant | `e2e:scrub --app` prints `SCRUB app=<id>` with `median` under 16 ms, `p95` at most 33.3 ms (two frames), `requests=0`, `frames>=48` |
| `query-speed` | 3 | all | Questions start answering in about a second | `e2e:perf --app` prints `PERF app=<id> first_token_p50_ms<=1200 n>=5 cached_query_ms<=20` |
| `data-quality` | 7 | all | Stale, missing and conflicting data are shown and explained, never hidden or filled | `e2e:quality --app` prints `QUALITY app=<id> ... stale=ok missing=ok conflict=ok cases>=3 shots>=3` (0.5); eval `quality` category passes, three runs (0.3); cargo `e2e_quality_cases` ok and at least 8 quality, conflict, stale or feed-state tests ok (0.2) |

### Be prepared to answer (9)

| Id | Weight | Threshold | In plain words | How it is checked |
|---|---|---|---|---|
| `question-rationale` | 3 | 0.7 | For each app: the question, why it matters, why these sources | `docs/interview-notes.md` has a heading naming the app; that section has 150+ words, says why, why it matters, names sources and links one (0.7); human review (0.3) |
| `design-alternatives` | 3 | 0.7 | Major choices with what else was considered and what it cost | `docs/design-alternatives.md`: 800+ words, at least 8 `##` sections that each name an alternative and a tradeoff, and it covers the three-app design (0.7); human review (0.3) |
| `scaling` | 3 | 0.7 | How it grows with more data, traffic, users and use cases | `docs/scaling.md`: 600+ words, a heading for each of data, traffic, users and use cases, and at least one number with a unit (0.7); human checks the numbers against `docs/perf.md` (0.3) |

### Our additions (12)

| Id | Weight | Threshold | In plain words | How it is checked |
|---|---|---|---|---|
| `three-apps` | 3 | all | Carp, lionfish and python each load with their own config, questions and data | `check-questions` prints `QUESTIONS carp>=48 lionfish>=48 python>=48 categories=10/10 ok` (0.3); config has the question and at least 6 helper questions (0.3); `e2e:firstload --app` prints `FIRSTLOAD app=<id> records>=1 errors=0` (0.4) |
| `app-selector` | 2 | 0.8 | The selector popover switches apps by URL, remembers, works by keyboard | `e2e:appselect` prints `APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms<500` (0.8); human looks at the three selector screenshots (0.2) |
| `push-first` | 3 | all | Push where the provider offers it; each poll says why not, with the provider's docs; everything lands through the signed hook | Probe over `docs/ingest-modes.md` tables with an App column: at least 3 rows per app, every row links provider docs, every poll row says why no push exists (itself or by pointing at a row that does) (0.6); cargo hook tests, at least 7, including the bad-signature 401 (0.4) |
| `realtime-messaging` | 3 | all | Direct messages stream per keystroke; notes edit live; under 100 ms locally | `e2e:dm` prints `DM chars_streamed=40/40 p50_ms<100 ... backspace=ok insert=ok persist=ok reload=ok` and `typing=ok presence=ok` (0.5); `e2e:notes` prints `NOTES ... live_edit=ok caret=ok converge=ok p50_ms<100 ... presence=ok` (0.5) |
| `only-three-species` | 1 | all | Dropped species are gone, not hidden | Exactly three app configs in `spec/apps/`, and no `tegu`, `iguana` or `Salvator merianae` in `api/src`, `apps/web/{client,server,shared,eval}` or `spec/apps` |

## The live eval

The agent criteria run the real agent: `bun run eval -- --app <id>` goes through Doppler `inversa/dev` to OpenRouter `openai/gpt-6-luna`. There is no stand-in model; `agent-grounding` greps for one. Model output varies, so a pass means three consecutive full passes (`repeat: 3`); one failed run fails the check and the remaining runs are skipped. The three eval-based criteria share one set of three runs per app, so a full grade costs three eval runs per app, not nine.

## What each later leaf must emit

A check stays PENDING until the file named under "requires" exists and prints the result line. Lines go to stdout, one line each, exact keys as below, `<id>` is the app id passed as `--app <id>`.

| Leaf | Command | Must print |
|---|---|---|
| A1a | `cargo test --manifest-path api/Cargo.toml` | tests named `app_config` (2+), `app_isolation`, `app_routes`, `app_scheduler`, a `schema` test; `spec/apps/{carp,lionfish,python}.json` with `id`, `question`, `feeds[].source`, `helperQuestions[]` |
| A1b | `bun run --cwd apps/web e2e:appselect`; `bun test -t "app config"` | `APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=<n>` |
| Q1 | `bun scripts/check-questions.ts` | `QUESTIONS carp=<n> lionfish=<n> python=<n> categories=10/10 ok` (each at least 48) |
| F1 | `docs/ingest-modes.md` | tables with `App` and `Mechanism` columns; one row per feed per app; provider URL in each row; poll rows say why there is no push |
| M1 | `e2e:dm`, `e2e:notes` | the `DM` and `NOTES` lines in `gates/leaf-M1.md` G4 to G6 |
| Agent and eval (L7, carp and python agent leaves) | `bun run eval -- --app <id>` | `EVAL app=<id> model=openai/gpt-6-luna questions=<n>`; `EVAL category <c> passed <p>/<t>` for lookup, change, explain, relevance, quality, planning, sources, replay, boundary, team; `EVAL ungrounded=<n> checked=<n>` (numbers in answers not found in any tool output, and how many numbers were checked); `EVAL passed <p>/<t>`; exit 0 only when every question passed and `ungrounded=0` (the grader stops repeating after a non-zero exit) |
| Agent e2e | `e2e:agent --app <id>` | `AGENT app=<id> flow=ok tools=<n> citation=ok` |
| Feeds (live) | `e2e:feeds --app <id>` (new script) | `FEEDS app=<id> fetched=<n> failed=<n> records=<n>` after a live poll window on a fresh data dir |
| Timeline | `e2e:replay --app <id>` (new script), `e2e:scrub --app <id>` | `REPLAY app=<id> play=ok step=ok asof=ok frames=<n> errors=<n>`; `SCRUB app=<id> median=<ms> p95=<ms> requests=<n> frames=<n>` |
| Evidence | `e2e:evidence --app <id>` (new script), `e2e:links --app <id>` | `EVIDENCE app=<id> citation=ok drawer=ok raw=ok source_link=ok new_tab=ok sources=<n>`; `EXTERNAL-LINKS app=<id> total=<n> new_tab=<n> unsafe=<n>` |
| Accessibility | `e2e:a11y --app <id>` | `AXE app=<id> serious=<n> critical=<n> scans=<n>`; `KEYBOARD-OK app=<id>` |
| Layout and mobile | `e2e:layout --app <id>`, `e2e:panels --app <id>` | `LAYOUT app=<id> ... legend=ok tooltip=ok ... mobile=ok`; `MOBILE app=<id> overflow=<n> hscroll=<n>`; `PANELS app=<id> table=<n> series=<n> ... drawer=1`; screenshots `docs/evidence/mobile/<id>-375.png`, `docs/evidence/<id>-desktop.png` |
| Perf | `e2e:perf --app <id>` | `PERF app=<id> first_token_p50_ms=<n> n=<n> cached_query_ms=<ms>` |
| Data quality | `e2e:quality --app <id>` | `QUALITY app=<id> cases=<n> stale=ok missing=ok conflict=ok shots=<n>` |
| First load | `e2e:firstload --app <id>` | `FIRSTLOAD app=<id> records=<n> errors=<n>` |
| H1 hardening | `e2e:prod --app <id>` | `PROD app=<id> health=ok ratelimit=ok costcap=ok errors=ok` |
| K1 cleanup | none | zero `tegu`, `iguana`, `Salvator merianae` in the scanned paths |
| D1 docs | files | `docs/new-technology.md`, `docs/design-alternatives.md`, `docs/scaling.md`, `docs/HUMAN_STEPS.md`, per-app sections in `docs/interview-notes.md` |
