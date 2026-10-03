# Gates: voice writes in chat + info cards with sources, prettier sources, Fastino decisions API, chat flow tested

Branch: polish-for-review (PR #5 stacked). Checks run from the repo root.

- [ ] G1 Voice transcripts and spoken answers appear in the chat thread as messages (user and assistant), not only in the voice strip.
  CHECK: cd apps/web && bun test tests/client/voice tests/client/agent 2>&1 | tail -4
  EXPECT: 0 fail
  EVIDENCE: pending

- [ ] G2 The voice can pull up an info card with sources: a `show_card` UI command (title, text, source evidence ids) renders a card in the chat thread and the sources open the sighting/feed.
  CHECK: cd apps/web && bun test tests/shared tests/server/voice 2>&1 | tail -4
  EXPECT: 0 fail
  EVIDENCE: pending

- [ ] G3 Sources are redesigned (chips with source name, type, age, favicon-free icon, hover title, click opens the record) and shown on text and voice answers.
  EVIDENCE: pending

- [ ] G4 Fastino API is called for real with FASTINO_API_KEY (key never printed or committed); the adapter has typed errors, timeout and a fallback when the key is missing.
  CHECK: cd apps/web && bun test tests/server/fastino 2>&1 | tail -4
  EXPECT: 0 fail
  EVIDENCE: pending

- [ ] G5 Fastino is used as a decisions layer: (a) intent routing of a user message (on-topic/off-topic, which tools/UI action) before the big model, (b) used by both text agent and voice, (c) falls back to the existing flow when unavailable.
  EVIDENCE: pending

- [ ] G6 Chat agent flow tested end to end against the running dev stack: 6+ scripted questions (on-topic, off-topic, UI control, carp sightings, conditions) with recorded outcomes and latency.
  EVIDENCE: pending

- [ ] G7 Whole suite green: bun run check:ci, bun run test, cargo test.
  CHECK: cd apps/web && bun run test 2>&1 | grep -E " fail$"
  EXPECT: 0 fail
  EVIDENCE: pending

- [ ] G8 Committed and pushed on the branch; PR description updated.
  EVIDENCE: pending
