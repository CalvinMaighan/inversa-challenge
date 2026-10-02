# Gates: Everglades Ops (root)

Scope: docs/BUILD_BRIEF.md R1–R19 delivered, integrated, and deployed at https://inversa.calvinmaighan.dev.

- [ ] G1: bun run check is green (lint, typecheck, web tests, api tests)
  CHECK: bun run check 2>&1 | tail -1
  EXPECT: CHECK-OK
  EVIDENCE: pending

- [ ] G2: the api suite passes
  CHECK: cargo test --manifest-path api/Cargo.toml 2>&1 | grep "test result" | grep -v " 0 passed" | head -1
  EXPECT: /test result: ok\. \d+ passed; 0 failed/
  EVIDENCE: pending

- [ ] G3: the live agent eval passes (OpenRouter gpt-6-luna under doppler; at least 13 of 15, quality at least 4 of 5)
  CHECK: bun run eval 2>&1 | grep -E "^EVAL (quality )?passed" | tr '\n' ' '
  EXPECT: /EVAL quality passed [45]\/5 EVAL passed 1[3-5]\/15/
  EVIDENCE: pending

- [ ] G4: every leaf and node gates file is met, or has only live-blocked ABANDON lines
  CHECK: node /Users/calvin/.claude/skills/unlazy/scripts/gate-check.mjs --timeout 120 --status gates/*.md 2>&1 | tail -3
  EXPECT: /ALL MET|ABANDON/
  EVIDENCE: pending

- [ ] G5: live URL checks from T33–T35 (manual: quote curl outputs)
  EVIDENCE: pending

- [ ] G6: a table mapping R1–R19 to their met gates is in the final report (manual)
  EVIDENCE: pending
