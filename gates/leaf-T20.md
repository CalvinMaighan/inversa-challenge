# Gates: T20 signal Worker (opus)

Scope: apps/signal-worker, a Cloudflare Worker implementing PLAN C9 over an R2 binding:
- a peer list with a 60 s heartbeat TTL and etag `onlyIf` writes;
- a per-peer inbox, read then deleted;
- `/turn` minting Cloudflare Realtime TURN credentials from CF_TURN_KEY_ID and CF_TURN_KEY_TOKEN;
- CORS for ALLOWED_ORIGIN only, and CORP cross-origin on every response;
- input validation and size caps.

- [x] G1: worker unit tests pass (bun test with an in-memory R2 stub)
  CHECK: bun run --cwd apps/signal-worker test 2>&1 | grep -E "[0-9]+ fail" | head -1
  EXPECT: /^ *0 fail/m
  EVIDENCE: 0 fail

- [x] G2: typecheck clean
  CHECK: bun run --cwd apps/signal-worker typecheck >/dev/null 2>&1 && echo TC-OK
  EXPECT: TC-OK
  EVIDENCE: TC-OK

- [x] G3: a scripted two-peer exchange against `bunx wrangler dev --local` (announce x2, list, offer, answer, ice, inbox drained) prints EXCHANGE-OK
  CHECK: bun run --cwd apps/signal-worker e2e 2>&1 | tail -1
  EXPECT: EXCHANGE-OK
  EVIDENCE: EXCHANGE-OK

- [x] G4: a disallowed origin gets no CORS allow header, and every response has CORP cross-origin (tests)
  CHECK: bun run --cwd apps/signal-worker test 2>&1 | grep -ciE "cors|corp"
  EXPECT: /[1-9]/
  EVIDENCE: 9

- [ ] G5: (live, blocked on H3) the deployed worker URL answers GET /rooms/demo/peers with 200 (quote)
  EVIDENCE: pending

ABANDON: G5 blocked on H3 (Cloudflare account resources)
