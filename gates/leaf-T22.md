# Gates: T22 node-data

Scope: integration node; see gates/node-data.md.

- [x] G1: node gates met
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/node-data.md 2>&1 | tail -2
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: gates/node-data.md: 4 gates | ALL MET (4 met)

- [x] G2: a boot registers every source; with INVERSA_SOURCES=off none runs, and sources without secrets (GOES, NWWS, hook) show as down with a `disabled: <reason>` note instead of being omitted
  CHECK: cargo test --manifest-path api/Cargo.toml -- supervisor_start_upserts_sources_without_running_them disabled_source_is_down_with_reason 2>&1 | grep -E "running [1-9]|test result"
  EXPECT: /running 2 tests[\s\S]*test result: ok\. 2 passed/
  EVIDENCE: running 2 tests | test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 204 filtered out; finished in 0.01s

- [x] G3: (manual, live) the release binary with a temp data dir, INVERSA_SOURCES=on and no secrets fetches from the live pollers for about 90 s; `feeds` over curl shows them, with GOES and NWWS down with a note
  EVIDENCE: 2026-09-30 21:36:25Z boot, `feeds` at about +95 s (127.0.0.1:4722, data dir in scratchpad, not committed). Log: `scheduler: source disabled: GOES_SQS_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY not set source="goes19"`, same for nwws and web, `scheduler: 8 source tasks running`, 0 WARN lines, `frames rebuilt ... (721 frames) in 369ms`. feeds: coops NOMINAL run=12 | gbif LAGGING run=56 (newest 10d 3h old) | goes19 DOWN "disabled: GOES_SQS_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY not set" | inat STALE run=85 (newest 1d 6h old; max 6h) | nas STALE run=80 (newest 131d old; max 60d) | ndbc LAGGING run=70 (36m old) | nws STALE run=14 (newest alert onset 1h 20m old; max 15m) | nwws DOWN "disabled: NWWS_USER and NWWS_PASS not set; alerts come from the nws poller" | openmeteo NOMINAL run=72 | usgs LAGGING run=61 (21m old) | web DOWN "disabled: INGEST_HOOK_SECRET not set". DB after the run: sightings 1469, readings 70356, alerts 4, stations 368, fetch_runs 85, frames 721. Routes: /health ok; GET /v1/frames (24 h, step 60) 200 application/x-evf 88652 B; POST /v1/ingest/hook/web 503 (secret missing); GET /v1/media/1399 200 image/jpeg 75760 B.

- [x] G4: (manual, live) `inversa-api backfill --days 2` against the network completes into a fresh temp data dir
  EVIDENCE: first run failed: GBIF search pages stall mid-body from offset ~10,000 (curl: offset 9,800 answers in 7 s, offsets 10,100/10,200/10,300/10,400 hang; the 5-year baseline count is 14,512), so `backfill page failed (6/6) ... offset=10200 ... operation timed out`, exit 101. Fixed in `ingest/poll/gbif.rs` (EventDate walks split per calendar year, MAX_OFFSET 10,000; test gbif_pager_walks_a_baseline_year_by_year). Re-run 21:56:49Z to 21:59:44Z, exit 0: `frames: rebuilt 721 hourly frames 1788210000000..1790802000000 in 1.119s` / `inat: payloads=7 rows_in=1154 written=1117 errors=0 sightings=1094 revisions=23 conflicts=22` / `nas: payloads=28 rows_in=2844 written=2844 errors=0 sightings=2844 linked=1652` / `gbif: payloads=52 rows_in=14445 written=14445 errors=0 sightings=14445 linked=3` / `BACKFILL-OK`. Two transient iNat connect errors retried (1/6).
