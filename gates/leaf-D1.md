# Gates: D1 docs, interview preparation and compliance re-audit for three apps (opus)

The brief (`docs/TASK_BRIEF.md`) ends with "Be prepared to answer questions about": (1) the question chosen, why it matters, why these data sources; (2) major product and technical design choices, alternatives considered and tradeoffs; (3) how the system would evolve for substantially more data, traffic, users or use cases. Docs are graded by `docs/grading/rubric.json` (read it: it names the files, headings and screenshots it checks) and read by a human interviewer. Write for that reader: plain, specific, honest about limits, no marketing. Never state a number you did not re-measure; label anything else "unverified".

You own: `README.md`, `docs/PRD.md`, `docs/brief-compliance.md`, `docs/demo-script.md`, `docs/interview-notes.md`, `docs/new-technology.md`, `docs/design-alternatives.md`, `docs/scaling.md`, `docs/APPS.md`, `docs/LIONFISH_WATCH.md` (kept as the lionfish spec), `docs/research.md` (decisions appended, history kept), `docs/perf.md` numbers only if re-measured, `docs/evidence/` screenshots you generate with the existing e2e scripts, `docs/OVERNIGHT_BRIEF.md` (mark done/superseded). Do not change code except `e2e` screenshot capture flags if needed. Work in your worktree, commit there, do not push. macOS has no `timeout`.

- [ ] G1: `docs/brief-compliance.md` is re-audited row by row against `docs/TASK_BRIEF.md` (technical requirements, deliverables, what we look for, what we do not care about, be prepared) for each of carp, lionfish, python and the system as a whole; every row is MET, PARTIAL or ABANDON with the reason; every MET row cites a gate file path or evidence path that exists (a script `scripts/check-compliance-paths.ts` verifies each cited path exists and prints `COMPLIANCE rows=<n> paths_ok=<n> missing=0`); PARTIAL and ABANDON rows are honest (live deployed URL not yet deployed, NWWS and GOES credentials pending, benchmark results with their real numbers)
  CHECK: bun scripts/check-compliance-paths.ts 2>&1 | tail -1
  EXPECT: /COMPLIANCE rows=\d+ paths_ok=\d+ missing=0/
  EVIDENCE: pending

- [ ] G2: `docs/interview-notes.md` has one section per app (carp, lionfish, python) answering the three be-prepared questions for that app: the question and why it matters to Inversa (carp: L'CARP launch May 2026 run by Inversa, Atchafalaya Basin, silver/grass/bighead/black carp; lionfish programs in Florida, Mexico, Belize, Colombia; python: PATRIC in the Everglades; each claim with its source URL from the evidence docs), why each data source (and the ones rejected), what each feed contributes and how fresh it is, the stale/missing/conflicting cases found in real data (KRZL1 datum mismatch, Monroe flow disagreement, DHW vs BAA, observed vs submitted lag, GBIF copies of iNat, Colombia NAS 2016), and the honest limits of the heuristics; plus a short "likely hard questions" list with straight answers (is the score predictive? why not X? what would you do with Inversa's private data?)
  EVIDENCE: pending

- [ ] G3: `docs/design-alternatives.md` has at least 10 sections, each naming a decision, the alternative(s) considered, the tradeoff and why this choice: one deployment with three apps vs three deployments; SQLite per app + Litestream vs Postgres/PostGIS; Rust Axum API vs Node; GraphQL + WebSocket subscriptions vs REST polling; push-first ingest with poll fallback vs all-poll; signed webhook hook and nudge vs direct DB writes; CRDT notes/messages over WebRTC vs server-authoritative chat; bitemporal forecast snapshots + IEM backfill vs live-only; EVF2 frame stream + SAB workers for scrubbing vs per-frame queries; blind benchmark with judge vs hint-fed evals; agent tool design vs text-to-SQL; Cesium vs MapLibre; honest-score components vs a single risk number
  CHECK: grep -c "^## " docs/design-alternatives.md
  EXPECT: /^\s*(1[0-9]|[2-9][0-9])\s*$/m
  EVIDENCE: pending

- [ ] G4: `docs/scaling.md` has headings for data, traffic, users and use cases (and operations/cost), each with concrete numbers from our system (rows per feed per day, frames size, DB sizes per app, agent cost per question from the eval, WS fan-out, RTC mesh limits) and what changes first at 10x and 100x: sharded writers/Postgres or ClickHouse for readings, object storage for frames and a CDN, queue-based ingest (SQS/NATS) with idempotent workers, SFU for >8 RTC peers, per-tenant agent budgets, regional read replicas, more apps as config (app config schema, feed adapters, score components), carp for other states, lionfish for other regions; what we would measure before deciding
  CHECK: grep -ciE "^#+ .*(data|traffic|users|use cases)" docs/scaling.md
  EXPECT: /^\s*([4-9]|[1-9][0-9]+)\s*$/m
  EVIDENCE: pending

- [ ] G5: `docs/new-technology.md` states honestly which technologies are new to the author and where they carry meaningful weight (check `README.md` and `docs/PRD.md` for the claim; likely candidates: Rust/Axum ingestion + SQLite writer/reader pools, CRDT over WebRTC data channels with a signal Worker, SharedArrayBuffer worker pipeline, EVF2 binary frames, NetCDF/GOES decode, ERDDAP, bitemporal store), what each does in the product, and why it is not decoration; PostGIS is explicitly not used and why
  EVIDENCE: pending

- [ ] G6: `README.md` and `docs/demo-script.md` describe the three-app product as it is: how to run (`bun run dev`, `bun run data`, `bun run grade`, `bun run eval`), the app selector, each app's question and what to try (3 to 5 steps each, using starter chips from the question files), the real-time DM/notes demo (two browsers), the replay "what we knew" demo for carp, the honesty rules; a 5-minute path through all three apps; the architecture diagram or table includes webhooks, nudges, pollers, websockets, workers, WebRTC, SQLite, GraphQL and active-state; all commands in the docs exist (a script `scripts/check-doc-commands.ts` extracts fenced `bun run <name>` and `cargo` commands from README/demo-script/HUMAN_STEPS and verifies the script names exist in package.json; prints `DOC-COMMANDS checked=<n> missing=0`)
  CHECK: bun scripts/check-doc-commands.ts 2>&1 | tail -1
  EXPECT: /DOC-COMMANDS checked=\d+ missing=0/
  EVIDENCE: pending

- [ ] G7: screenshots the rubric names exist and were looked at: `docs/evidence/<id>-desktop.png` and `docs/evidence/mobile/<id>-375.png` for carp, lionfish, python (regenerate with the existing e2e scripts; state which script produced each), plus the stale README image `docs/evidence/simplify-after.png` replaced or removed; findings stated
  CHECK: ls docs/evidence/carp-desktop.png docs/evidence/lionfish-desktop.png docs/evidence/python-desktop.png docs/evidence/mobile/carp-375.png docs/evidence/mobile/lionfish-375.png docs/evidence/mobile/python-375.png | wc -l
  EXPECT: /^\s*6\s*$/m
  EVIDENCE: pending

- [ ] G8: no unverified claim about Inversa or the world is stated as fact: every claim about Inversa, L'CARP, FWC, Origin has a source URL and date in the doc or is labelled unverified; no ChatGPT-only claim remains unlabelled (grep `docs/` for the three carp claims and show their sources); `bun scripts/grade.ts --validate` passes; `bun run check` clean (state counts)
  CHECK: bun scripts/grade.ts --validate 2>&1 | tail -1 && bun run check 2>&1 | tail -2
  EXPECT: /RUBRIC criteria=\d+ weight=100 ok[\s\S]*CHECK-OK/
  EVIDENCE: pending
