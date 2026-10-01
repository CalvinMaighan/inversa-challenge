# Gates: E1 backend evidence, ingest-mode and determinism follow-ups (opus)

Why: C5, L5 and F1 reported gaps that the UIs and agents depend on. You own: `api/src/evidence.rs`, `api/src/graphql/**` (evidence, sourceInfo), `api/src/review/**` (flow-conflict input, low-water, last-check), `api/src/ingest/push/{hook,nudge}.rs`, `api/src/app/mod.rs` (routes), `api/src/source_pages.rs`, `api/src/hotspot/lionfish.rs` tests only for clock pinning, `docs/ingest-modes.md` (as built), `api/schema.graphql`. Do not touch web or adapters other than registering nudge targets. Commit on your worktree branch, no push.

- [ ] G1: GraphQL `evidence(id)` resolves every id the engines cite: `forecast:<lid>:<issuedMs>` (snapshot with points, thresholds at that time, provenance), `reading:<station>:<param>:<ms>:<origin>`, `alert:<nwsId>` (first_seen/last_seen/ended), `review:<lid>:<asOfMs>` (the SiteReview with checks), `hotspot:...` (already), `source:<feedId>` (licence, credit/DOI, cadence, expected latency, rate limits, mode, homepage), `note:<id>`, `mission:<id>`, `message:<id>`; unknown ids give a typed NOT_FOUND; each record has `sourceUrl` where one exists; tests named `evidence_kind_`
  CHECK: cargo test --manifest-path api/Cargo.toml evidence_kind_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G2: `sourceInfo(feed)` / `sources` query returns, per feed of the app: mode (push|webhook|poll), cadence, observed latency (from fetch runs), licence and credit text, rate-limit notes, homepage, "why poll" for poll feeds (from config), last fetch and status; data lives in config/`source_pages.rs`, not hard-coded in the agent; test `source_info_`
  CHECK: cargo test --manifest-path api/Cargo.toml source_info_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G3: review follow-ups: (a) `source_conflict` flow half reads USGS `discharge_cfs` vs NWPS flow (kcfs) and fires at the configured ratio, never blends, labels both sources; (b) a `lowWater` flag from NWPS `low_threshold` state exposed on `SiteStatus`/`SiteReview`; (c) the alert poller's empty polls are recorded (last check time + status), so `activeAlerts=0` reports "checked at T" and a dead poller reads `cannot_assess` for the alert check instead of "no alerts"; tests named `review_followup_`
  CHECK: cargo test --manifest-path api/Cargo.toml review_followup_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G4: hook and nudge as designed in `docs/ingest-modes.md`: `POST /v1/{app}/ingest/hook/{source}` takes the raw body, HMAC over the raw bytes, idempotency key = sha256 of body (duplicate delivery is a no-op and answers 200 `duplicate`), size cap, replay window; `GET|POST /v1/{app}/ingest/nudge/{source}/{token}` exists for every nudge-capable feed (`crw`, `nws-alerts`, `nws-forecast`, `nwps`, `iem`), idempotent within 60 s, wakes that scheduler task; bad token 401, unknown app/source 404; tests named `ingest_hook_` and `ingest_nudge_`
  CHECK: cargo test --manifest-path api/Cargo.toml ingest_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G5: determinism: tests that depend on the wall clock (`lionfish_top_cells_on_fixtures`, the CRW fixture staleness, thin-window ageing, any `now()`-dependent fixture test across the suite) use a pinned clock (`Clock` trait or `FIXTURE_NOW`) so they pass on any date; prove it by running the full suite under `FAKETIME`-style override or by a test that sets the pinned clock to 2027-01-01 and still passes; document the mechanism in `api/src/state.rs` comments
  CHECK: cargo test --manifest-path api/Cargo.toml clock_pinned_ 2>&1 | grep -E "running|test result"
  EXPECT: /running [1-9][0-9]* tests?[\s\S]*test result: ok/
  EVIDENCE: pending

- [ ] G6: `docs/ingest-modes.md` is updated to what is built (modes, cadences, nudge routes, emitters), `/health` per app shows the true mode per feed (`push`, `webhook`, `poll`) and web chips can show them (GraphQL `FeedMode` gains `WEBHOOK`; schema-diff test passes); full api suite and clippy clean (state counts)
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep -E "^test result" | tail -2 && cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -1
  EXPECT: /test result: ok[\s\S]*Finished/
  EVIDENCE: pending
