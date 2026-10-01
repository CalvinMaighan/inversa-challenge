# Gates: M1 real-time WebRTC messaging and live notes (fable)

Contract: `PLAN.md` C-A7 (message shapes), C-A6 (rooms `<app>:main`). You own: `apps/web/client/threads/rtc.worker.ts`, `apps/web/client/threads/rtc/**`, `apps/web/client/hud/{notes,missions}/**` (note editing UI, a new `hud/messages/**` DM panel), `apps/web/client/state/{notes,peers,messages}.ts`, `apps/web/client/threads/crdt/**`, `api/src/crdt.rs`, `spec/crdt/**`, `packages/active-state/src/threads/**` only if the transport needs it, `apps/web/e2e/{dm.ts,notes.ts}`, mirrored tests, and the `e2e:dm` script line in `apps/web/package.json`. Do not touch `api/src/{state,app,graphql}` or `apps/web/shared/apps` (A1a/A1b). Room naming: use whatever `DEFAULT_BOARD_ID`/room helper exists; A1b changes it to `<app>:main`, so take the room id as a parameter and do not hard-code it. Do not commit to main, do not push.

Product intent: two viewers on the same app see each other typing direct messages character by character, and see a note being edited live (text and carets) while it is edited. Per-keystroke, not per-send.

- [ ] G1: protocol: `PeerMessage` gains `dm.delta`, `dm.commit`, `dm.typing`, `note.delta` exactly as C-A7; `isPeerMessage` validates them (rejects oversize text over 4 KB, unknown fields, wrong types); unit tests named `peer message dm`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "peer message dm" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: delta algebra: apply `{del, ins}` deltas in `seq` order, tolerate duplicates and reordering within a window (idempotent, resync on gap by requesting the full text), property test with random edit sequences on two replicas converging; test names contain `stream delta`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "stream delta" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: persistence: `dm.commit` persists as the CRDT `Message` with `to` and `thread`; Rust and TS runners agree on new vectors in `spec/crdt` (message-thread, message-concurrent-commit); the existing 17 vectors still pass in both runners
  CHECK: cargo test --manifest-path api/Cargo.toml crdt 2>&1 | grep -E "test result" && cd apps/web && bun test --tsconfig-override ./tsconfig.json tests/client/threads/crdt 2>&1 | grep -E "pass|fail"
  EXPECT: /test result: ok[\s\S]*[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G4: DM e2e on the real stack with two browser contexts: A types a 40-character message, B's DM panel shows each character within the latency budget as typed (including backspace and mid-text insert); on commit both show one final message, a reload shows it from persistence; prints `DM chars_streamed=40/40 p50_ms=<n> p95_ms=<n> backspace=ok insert=ok persist=ok reload=ok` with p50 < 100
  CHECK: cd apps/web && bun run e2e:dm 2>&1 | grep "^DM "
  EXPECT: /DM chars_streamed=40\/40 p50_ms=([0-9]|[1-9][0-9])\b[^\n]*backspace=ok insert=ok persist=ok reload=ok/
  EVIDENCE: pending

- [ ] G5: typing indicator and presence: B sees "A is typing" while deltas flow and it clears within 3 s after the last delta or on commit; offline peer shows as away; covered in the DM e2e line `typing=ok presence=ok`
  CHECK: cd apps/web && bun run e2e:dm 2>&1 | grep -c "typing=ok presence=ok"
  EXPECT: /^1$/
  EVIDENCE: pending

- [ ] G6: live notes e2e: two contexts open the same note; A types, B sees characters and A's caret live; both edit different notes concurrently; both converge after concurrent edits to the same note (LWW on commit with no lost keystroke streams shown as final garbage); the existing note CRUD flow still works; prints `NOTES live_edit=ok caret=ok converge=ok p50_ms=<n> presence=ok` with p50 < 100
  CHECK: cd apps/web && bun run e2e:notes 2>&1 | grep "^NOTES "
  EXPECT: /NOTES [^\n]*live_edit=ok caret=ok converge=ok p50_ms=([0-9]|[1-9][0-9])\b[^\n]*presence=ok/
  EVIDENCE: pending

- [ ] G7: resilience: a peer that drops mid-message (channel closed) resyncs on reconnect and no ghost "typing" remains; rate limit and size caps hold (a flood test of 10k deltas in 1 s is throttled to at most 60 sent per second per peer and the receiver stays responsive, main thread long task under 50 ms); tests named `dm resilience`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "dm resilience" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G8: security notes: DM text is rendered as text only (no HTML injection; test with `<img src=x onerror=...>`), authorship comes from the channel identity and a peer cannot spoof `from`; `docs/security.md` gets a short messaging section; test named `dm injection`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "dm injection" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G9: web tests, typecheck, lint, axe on the DM panel and notes editor (0 violations) and keyboard operation; screenshots (looked at) `docs/evidence/dm-streaming.png`, `notes-live.png`
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending
