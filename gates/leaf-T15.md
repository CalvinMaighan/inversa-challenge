# Gates: T15 voice port (grok-voice) (opus)

Scope:
- Port deedee `client/voice/*`, `server/voice/*` and `app/api/voice/session/**` into apps/web, following C8.
- UI tools from `shared/voice/ui-tools.ts` are emitted as `ui.command` events; the client applies them to active-state keys (VIEW, TIME, LAYERS, SELECTION).
- `spawn_thinking`, `get_task_status` and `cancel_task` run T13's runTurn (resolved via an injected interface, so T13 can land in parallel).
- `view_screen` returns the HUD state as JSON.
- Caps: VOICE_MAX_SESSION_MS per session and VOICE_DAILY_MINUTES per day.
- Auth is replaced by a per-session token only (no Supabase).

- [x] G1: voice tests pass
  CHECK: cd apps/web && bun test tests/server/voice tests/client/voice 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"
  EXPECT: /([1-9][0-9]*) pass\s+0 fail/
  EVIDENCE: 62 pass | 0 fail

- [x] G2: PCM resample produces the expected sample count at 16 kHz from a 48 kHz input, phase-continuous across batches (test)
  CHECK: cd apps/web && bun test tests/client/voice -t "resample" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9] pass[\s\S]*0 fail/
  EVIDENCE: 4 pass | 0 fail

- [x] G3: a mocked xAI socket session: the model calls fly_to, the relay emits ui.command, and the client handler sets the VIEW key (test)
  CHECK: cd apps/web && bun test tests -t "fly_to reaches VIEW" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G4: invalid UI tool args are rejected and reported back to the model as a tool error, never forwarded (test)
  CHECK: cd apps/web && bun test tests -t "rejects invalid ui tool" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G5: the daily minute cap refuses a new session with 429 once exceeded (test)
  CHECK: cd apps/web && bun test tests -t "daily voice cap" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G6: typecheck and lint clean
  CHECK: bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN

- [x] G8: agent events of a spawned task reach the client as task.event, in order, through the onTaskEvent subscribe API (test)
  CHECK: cd apps/web && bun test tests -t "task events stream to client" 2>&1 | grep -E "pass|fail"
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: 1 pass | 0 fail

- [x] G9: next build succeeds with the voice routes bundled against the real agent runner
  CHECK: bun run --cwd apps/web build >/dev/null 2>&1 && echo BUILD-OK
  EXPECT: BUILD-OK
  EVIDENCE: BUILD-OK

- [ ] G7: (live, blocked on H6) spoken "fly to Flamingo" moves the globe; measured end-of-speech-to-camera-move latency is under 800 ms (quote the measurement)
  EVIDENCE: pending

ABANDON: G7 blocked on H6 (XAI_API_KEY) and T14/T17 UI
