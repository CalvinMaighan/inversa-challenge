# Gates: voice writes in chat + info cards with sources, prettier sources, Fastino decisions API, chat flow tested

Branch: polish-for-review (PR #5 stacked). Checks run from the repo root.

- [x] G1 Voice transcripts and spoken answers appear in the chat thread as messages (user and assistant), not only in the voice strip.
  CHECK: cd apps/web && bun test tests/client/agent/chat/voice-thread.test.ts 2>&1 | tail -4
  EXPECT: 0 fail
  EVIDENCE: voice-runtime.ts dispatches voice_user (final transcript.user) and voice_say (final transcript.assistant, origin turn) through client/agent/chat/store.ts; reducer tests: 4 pass (tag voice, replace on re-final, card, follow-ups).

- [x] G2 The voice can pull up an info card with sources: a `show_card` UI command (title, text, sources) renders a card in the chat thread and the sources open the record; the analyst's sources reach the voice in the result context.
  CHECK: cd apps/web && bun test tests/client/voice tests/server/voice tests/shared 2>&1 | tail -4
  EXPECT: 0 fail
  EVIDENCE: shared/voice/ui-tools.ts show_card; ui-command-handler.ts dispatches the card; guards.test.ts "result context sources"; ui-command-handler.test.ts "show_card pins an info card". Text agent also has show_card (live flow: "Pin a card about the newest lionfish report" -> sightings, show_card, ui:show_card).

- [x] G3 Sources are redesigned (rows with kind icon, number, title, kind and source, hover title, click opens the record, "show N more") on text and voice answers and cards.
  EVIDENCE: client/agent/SourceList.tsx (SourceList, InfoCardView, FollowUps) replaces SourceChip; seen in the browser pane under a carp answer ("SOURCES 1, Bighead carp, Sighting · 2026-08-16 · iNaturalist").

- [x] G4 Fastino is called for real with FASTINO_API_KEY (never printed or committed); typed errors, timeout, retry, breaker, fallback without a key.
  CHECK: cd apps/web && bun test tests/server/fastino 2>&1 | tail -4
  EXPECT: 0 fail
  EVIDENCE: server/fastino/glide.ts (POST api.fastino.ai/v1/systemone, X-API-Key) and gliner.ts (/v1/chat/completions, gliner2.5-decide). Live: router calls answered in 0.4 to 1.1 s; follow-ups 0.3 to 0.6 s. Key is read from env only; error messages carry status and API message, never key or state (tested).

- [x] G5 Fastino is a decisions layer used by text and voice: routing (on_topic, intent) with deterministic off-topic and greeting replies, hints for the model, ask-next ranking, voice stop decision, voice eager analyst start; all fall back to the old flow.
  EVIDENCE: server/agent/decisions.ts + run-turn.ts (router line in debug events, model "glide-router" for shortcuts: off-topic reply in 1.1 s against 5.7 s before); server/agent/followups.ts + app/api/agent/followups; server/voice/stop-intent.ts decidesStop and voice-session.ts decideAndAct. Tests: decisions.test.ts, followups.test.ts, glide.test.ts.

- [x] G6 Chat agent flow tested against real services: 4 conversations, 12 turns, with router decisions, tools, latency and answers recorded in docs/evidence/chat-flow-2026-10-03.txt.
  EVIDENCE: docs/evidence/chat-flow-2026-10-03.txt. Bugs found and fixed by the run: carp_sightings model-supplied bbox gave 2 instead of 245 silver carp (bbox removed, whole basin by default, 730 days); a "Mississippi River Basin" place made a 1 degree box (area boxes now scale with the camera altitude); GLiDE took 8 to 12 s when unsure of many options (router timeout 2.5 s, follow-ups moved to GLiNER2.5-Decide at 0.3 to 0.6 s); set_view and zoom tried instead of fly_to (descriptions steer to fly_to).

- [x] G7 Whole suite green: bun run check:ci, bun run test, cargo test.
  CHECK: cd apps/web && bun run test 2>&1 | grep -E " fail$"
  EXPECT: 0 fail
  EVIDENCE: bun 1234 pass 0 fail; check:ci ok; cargo not touched in this leaf (404 pass at the previous commit).

- [ ] G8 Committed and pushed on the branch; PR description updated.
  EVIDENCE: pending
