# Gates: T31 security pass

Scope: verify the HMAC hook, the media proxy SSRF guard, signal Worker CORS, that no secrets reach the client bundle, and rate limits on /api/agent and /api/voice.

- [ ] G1: no secret names or key prefixes appear in the client bundle
  CHECK: cd apps/web && bun run build >/dev/null 2>&1 && grep -rlE "OPENROUTER_API_KEY|sk-or-[A-Za-z0-9-]{20}|XAI_API_KEY|INGEST_HOOK_SECRET|R2_SECRET|sk-[A-Za-z0-9]{20}|xai-[A-Za-z0-9]{20}" .next/static | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: pending

- [ ] G2: /api/agent/stream and /api/voice/session are rate limited per IP (test: the 11th request within a minute returns 429)
  CHECK: cd apps/web && bun test tests -t "rate limit" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: the hook, media SSRF and CORS tests still pass on the merged tree
  CHECK: cargo test --manifest-path api/Cargo.toml hook 2>&1 | grep "test result" && cargo test --manifest-path api/Cargo.toml media 2>&1 | grep "test result" && bun run --cwd apps/signal-worker test 2>&1 | grep -E "[0-9]+ fail"
  EXPECT: /test result: ok[\s\S]*test result: ok[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G4: docs/security.md records the threat model and each control with its file path
  CHECK: grep -cE "\.rs|\.ts" docs/security.md
  EXPECT: /[5-9]|[1-9][0-9]/
  EVIDENCE: pending
