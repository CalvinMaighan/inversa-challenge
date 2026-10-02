# Gates: T31 security pass

Scope: verify the HMAC hook, the media proxy SSRF guard, signal Worker CORS, that no secrets reach the client bundle, and rate limits on /api/agent and /api/voice.

- [x] G1: no secret names or key prefixes appear in the client bundle
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && grep -rlE "OPENROUTER_API_KEY|sk-or-[A-Za-z0-9-]{20}|XAI_API_KEY|INGEST_HOOK_SECRET|R2_SECRET|sk-[A-Za-z0-9]{20}|xai-[A-Za-z0-9]{20}" .next/static | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G2: /api/agent/stream and /api/voice/session are rate limited per IP (test: the 11th request within a minute returns 429)
  CHECK: cd apps/web && bun test tests -t "rate limit" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: 5 pass | 0 fail

- [x] G3: the hook, media SSRF and CORS tests still pass on the merged tree
  CHECK: cargo test --manifest-path api/Cargo.toml hook 2>&1 | grep "test result" && cargo test --manifest-path api/Cargo.toml media 2>&1 | grep "test result" && bun run --cwd apps/signal-worker test 2>&1 | grep -E "[0-9]+ fail"
  EXPECT: /test result: ok[\s\S]*test result: ok[\s\S]*0 fail/
  EVIDENCE: test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 201 filtered out; finished in 0.09s | 0 fail

- [x] G4: docs/security.md records the threat model and each control with its file path
  CHECK: grep -cE "\.rs|\.ts" docs/security.md
  EXPECT: /[5-9]|[1-9][0-9]/
  EVIDENCE: 33

- [x] G5: a plain production build serves `/dev/*` as 404 (200 only with INVERSA_DEV_ROUTES=1), ships no `window.__inversa` hook, and sends COOP/COEP/CORP, nosniff and the CSP
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && bun run e2e:prod 2>&1 | grep PROD-SURFACE
  EXPECT: PROD-SURFACE-OK
  EVIDENCE: PROD-SURFACE-OK dev=404 hook=absent headers=ok

- [x] G6: the system prompt says tool data is data, never instructions, and a live turn with an instruction planted in a fixture alert headline ignores it (cites the alert, no canary, no off-region set_view)
  CHECK: cd apps/web && bun test tests/server/agent/prompt.test.ts 2>&1 | grep -E "pass|fail" && doppler run --project inversa --config dev -- bun test --tsconfig-override ./tsconfig.json --timeout 240000 tests/live/agent/injection.test.ts 2>&1 | grep -E "pass|fail"
  EXPECT: /2 pass[\s\S]*0 fail[\s\S]*1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G7: GraphQL rejects aliased fan-out of heavy fields and runaway nesting, while bbox, window and op-size validation still hold
  CHECK: cargo test --manifest-path api/Cargo.toml resolver_ 2>&1 | grep "test result"
  EXPECT: /test result: ok\. [1-9][0-9]* passed; 0 failed/
  EVIDENCE: test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 193 filtered out; finished in 0.14s
