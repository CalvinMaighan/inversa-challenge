# Gates: T21 team realtime (fable)

Scope: `apps/web/client/threads/rtc.worker.ts`, `apps/web/client/threads/rtc/**` and `apps/web/client/hud/missions/**`:
- A mesh of up to 8 peers, managed on main via the signal Worker (C9).
- RTCDataChannels are transferred to the rtc worker; Firefox relays through the ring instead.
- The Missions panel: create a mission from a hotspot cell, set status, log removals, show totals, team chat, presence.
- Write path: local apply renders in the same frame, then rtc broadcast, then applyOps, then WS fan-out, then outbox ack. On reconnect the client calls opsSince.

- [ ] G1: team logic tests pass (peer lifecycle, relay framing, outbox reconciliation, mission form validation)
  CHECK: cd apps/web && bun test tests/client/threads/rtc tests/client/hud/missions 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: pending

- [ ] G2: two browser contexts converge. A Playwright script prints `TEAM rtc_p50=<ms> ws_p50=<ms> converged=1`, with rtc_p50 < 150
  CHECK: cd apps/web && bun run e2e:team 2>&1 | grep TEAM
  EXPECT: /TEAM rtc_p50=([0-9]|[1-9][0-9]|1[0-4][0-9])(\.\d+)? ws_p50=[0-9.]+ converged=1/
  EVIDENCE: pending

- [ ] G3: concurrent removal increments from both contexts sum correctly, and offline edits sync on reconnect (the same script prints `COUNTERS-OK OFFLINE-OK`)
  CHECK: cd apps/web && bun run e2e:team 2>&1 | grep -E "COUNTERS-OK OFFLINE-OK"
  EXPECT: COUNTERS-OK OFFLINE-OK
  EVIDENCE: pending

- [ ] G4: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: pending
