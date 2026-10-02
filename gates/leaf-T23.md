# Gates: T23 node-client

Scope: integration node; see gates/node-client.md.

- [x] G1: node gates met
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/node-client.md 2>&1 | tail -2
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: gates/node-client.md: 4 gates | ALL MET (4 met)

- [x] G2: TIME outside the 30-day window recentres it: a share link to 2026-02-01T17:00Z (cold-snap scene) moves the window, the db worker fetches it, and the iguana hotspot at cell 292:142 reads the demo-script score 1.58 with sightings in the frame and on the globe
  CHECK: cd apps/web && E2E_SKIP_BUILD=1 bun run e2e:client 2>&1 | grep "^COLDSNAP"
  EXPECT: /^COLDSNAP at=2026-02-01T17:00:00\.000Z window=2026-01-17T17:00:00\.000Z\.\.2026-02-16T17:00:00\.000Z iguana=1\.58 .*sightings=[1-9].*globe_sightings=[1-9].*badge=REPLAY date=2026-02-01 errors=0$/m
  EVIDENCE: COLDSNAP at=2026-02-01T17:00:00.000Z window=2026-01-17T17:00:00.000Z..2026-02-16T17:00:00.000Z iguana=1.58 max=2.00 sightings=6 globe_sightings=40 globe_hotspots=206 badge=REPLAY date=2026-02-01 error

- [x] G3: screenshots looked at: `docs/evidence/ops-main.png` (real stack, live edge) and `docs/evidence/cold-snap.png` (2026-02-01T17:00Z, iguana hotspot over Coral Gables)
  EVIDENCE: ops-main.png: next dev + Axum over the fixture, network (2 days) and scene backfill with live pollers and the signal Worker; LIVE badge, 720-frame grid, stations, sightings and pink hotspot patches over South Florida, Missions panel open, no console errors. cold-snap.png: REPLAY badge, date field 2026-02-01, 17:00:00Z, window 19.01..15.02 on the timeline with the alert bands at 01.02, iguana markers and the red-orange hotspot over Coral Gables / South Miami
