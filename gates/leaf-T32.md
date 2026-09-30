# Gates: T32 docs

Scope:
- README: run locally, architecture, decisions, tradeoffs, and the scaling story from PRD §17.
- docs/demo-script.md.
- docs/interview-notes.md: question choice, sources, alternatives considered.

- [x] G1: the README has run, architecture, decisions and scaling sections
  CHECK: for s in "Run locally" "Architecture" "Decisions" "Scaling"; do grep -q "## $s" README.md || m=$((m+1)); done; echo "missing=${m:-0}"
  EXPECT: missing=0
  EVIDENCE: missing=0

- [x] G2: the demo script and interview notes exist and are non-trivial (> 40 lines each)
  CHECK: wc -l docs/demo-script.md docs/interview-notes.md | awk '$1>40 && $2!="total"{n++} END{print "long="n}'
  EXPECT: long=2
  EVIDENCE: long=2

- [x] G3: every command in the README "Run locally" section was executed and works (manual: quote the outputs)
  EVIDENCE: run 2026-09-30 in this worktree at 81596be, data dir in the session scratchpad (not committed). (1) `bun install`: `978 packages installed [2.97s]`. (2) `INVERSA_DATA_DIR=<tmp> DAYS=1 bun run data`: `frames: rebuilt 721 hourly frames ... in 689.723083ms` | `inat: payloads=4 rows_in=592 written=577 ... errors=0 sightings=566 revisions=11 conflicts=10` | `nas: payloads=28 rows_in=2844 ... linked=1652` | `gbif: payloads=52 rows_in=14445 ... errors=0` | `BACKFILL-OK` | scene: `inat 141, openmeteo 95520, usgs 71167, nwws 110 rows_in, errors=0` | `scene cold-snap-2026-02-01 [...]: sightings=254 readings=165951 air_below_10c=5328 alerts=42` | `BACKFILL-OK` | `exit=0 elapsed=231s`. (3) `bun run dev`: the main checkout's own `bun run dev` held 4041 and 3050, so the web child printed `Error: listen EADDRINUSE: address already in use :::3050` and dev.ts stopped both (the README now says both ports must be free). Ran the same two children with dev.ts's env on 4141/3150 (INVERSA_BIND, INVERSA_API_ORIGIN, NEXT_PUBLIC_INVERSA_WS_URL, AGENT_HARNESS=mock): `api health after 1s: ok` | `GET /` `HTTP/1.1 200 OK`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` | feeds through the Next /v1 rewrite: coops LAGGING 659 s, goes19 DOWN `disabled: GOES_SQS_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY not set`, inat LAGGING 962 s | `GET /v1/frames` for the scene: `status=200 type=application/x-evf bytes=553336` (121 frames) | in the Browser pane on http://localhost:3150 the globe, 11 feed chips, timeline and orb rendered; a typed golden question streamed a cited answer, the chip opened `EVIDENCE · HOTSPOT` and Backtest python loaded; on 127.0.0.1 dev assets answered 403 (README notes it). (4) mock mode: `curl -X POST .../dev/agent/mock` returned `{"scripted":["Where should python crews go tonight?",...]}`; asking all 15 on the local DB: 7 OK, 8 `replay: no matching ... row` (README lists the 7). (5) offline: `INVERSA_SOURCES=off cargo run -q --release ... -- backfill --fixtures` printed 10 source lines, `frames: rebuilt 721 hourly frames`, `BACKFILL-OK`, `exit=0 elapsed=2s`. (6) Bun loads a root `.env.local` into `bun run` scripts and their children: scratch test printed `child sees FOO_T32=from-dotenv`. Testing numbers in the README re-measured the same day: `bun run test` web 516/active-state 96/signal-worker 35/active-theme 4 pass, 0 fail; `cargo test` `205 passed; 0 failed; 2 ignored`; replay eval `EVAL passed 15/15`; `bun run check` ends `CHECK-OK`.

- [x] G4: docs/brief-compliance.md exists and maps the brief in at least 20 table rows, each with a status
  CHECK: test -f docs/brief-compliance.md && n=$(grep -cE '^\| [0-9]+ \|.*\| (MET|IN PROGRESS|BLOCKED|N/A)' docs/brief-compliance.md) && echo "rows=$n" && test "$n" -ge 20 && echo ROWS-OK
  EXPECT: ROWS-OK
  EVIDENCE: rows=37 | ROWS-OK
