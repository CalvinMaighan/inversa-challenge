import { describe, expect, test } from "bun:test";

import { asThread, EMPTY_THREAD, reduceThread, type AgentThread } from "client/agent/chat/thread";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const run = (actions: Parameters<typeof reduceThread>[1][]): AgentThread => actions.reduce(reduceThread, EMPTY_THREAD);

describe("voice in the chat thread", () => {
  test("what the user said and what the voice said become messages, tagged voice", () => {
    const t = run([
      { type: "voice_user", id: "voice-user-1", text: "How many silver carp are there?", nowMs: NOW },
      { type: "voice_say", id: "voice-say-r1", text: "Let me check.", nowMs: NOW + 1000 },
    ]);
    expect(t.messages.map((m) => [m.role, m.source, m.status, m.text])).toEqual([
      ["user", "voice", "done", "How many silver carp are there?"],
      ["assistant", "voice", "done", "Let me check."],
    ]);
  });

  test("a transcript finalised twice replaces itself instead of repeating", () => {
    const t = run([
      { type: "voice_user", id: "voice-user-1", text: "how many", nowMs: NOW },
      { type: "voice_user", id: "voice-user-1", text: "how many silver carp", nowMs: NOW },
    ]);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]!.text).toBe("how many silver carp");
  });

  test("an info card is a finished assistant message carrying its title and sources", () => {
    const card = { title: "Newest bighead report", text: "Reported on 2026-08-29 near St. Louis.", sources: [{ id: "fish:inat:1", kind: "fish" as const, label: "Bighead carp · 2026-08-29 · iNaturalist" }] };
    const t = run([{ type: "card", id: "card-1", card, nowMs: NOW }]);
    expect(t.messages[0]).toMatchObject({ role: "assistant", status: "done", card, citations: card.sources });
  });

  test("follow-up questions attach to the answer they follow, and not to a missing one", () => {
    const base = run([{ type: "assistant", id: "a1", nowMs: NOW }]);
    expect(asThread(reduceThread(base, { type: "followups", id: "a1", items: ["Q1", "Q2"] })).messages[0]!.followUps).toEqual(["Q1", "Q2"]);
    expect(reduceThread(base, { type: "followups", id: "nope", items: ["Q1"] })).toEqual(base);
  });
});
