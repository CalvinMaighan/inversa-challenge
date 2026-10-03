import { beforeEach, describe, expect, test } from "bun:test";

import { greetingReply, hintFor, INTENTS, offTopicReply, routeMessage, shortcutFor, type Route } from "@/server/agent/decisions";
import { resetGlideBreaker } from "@/server/fastino/glide";
import { APP_IDS, getApp } from "@/shared/apps";

const CARP = getApp(APP_IDS[0]);
const route = (patch: Partial<Route> = {}): Route => ({ intent: "reports", intentConfidence: 0.99, onTopic: 0.97, suggestedTools: ["carp_sightings", "geocode"], latencyMs: 700, ...patch });

beforeEach(() => resetGlideBreaker());

function fakeFetch(intent: string, onTopic: number, confidence = 0.99) {
  let body: { state: Record<string, unknown>; questions: Record<string, { criteria: Record<string, string> }> } | null = null;
  const impl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        answers: {
          on_topic: { type: "noul", noul: onTopic, confidence: Math.abs(2 * onTopic - 1) },
          intent: { type: "choice", choice: intent, confidence, probabilities: {} },
        },
        usage: { input_tokens: 300 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, sent: () => body! };
}

describe("routeMessage", () => {
  test("asks two questions about the message, the app and the last turns, and reads the answers", async () => {
    const f = fakeFetch("reports", 0.97);
    const out = await routeMessage({ app: CARP, question: "How many silver carp are there?", history: [{ role: "user", content: "hello" }], glide: { apiKey: "k", fetchImpl: f.impl } });
    expect(out).toMatchObject({ intent: "reports", onTopic: 0.97 });
    expect(out?.suggestedTools).toContain("carp_sightings");
    expect(out?.suggestedTools).not.toContain("sightings");
    const sent = f.sent();
    expect(Object.keys(sent.questions)).toEqual(["on_topic", "intent"]);
    expect(sent.state.message).toBe("How many silver carp are there?");
    expect(sent.state.conversation).toEqual(["user: hello"]);
    // Carp has no priority intent.
    expect(Object.keys(sent.questions.intent!.criteria)).not.toContain("priority");
  });

  test("an answer outside the intent list is not trusted", async () => {
    const odd = await routeMessage({ app: CARP, question: "q", glide: { apiKey: "k", fetchImpl: fakeFetch("poetry", 0.9).impl } });
    expect(odd).toBeNull();
  });

  test("is null when GLiDE is unavailable", async () => {
    const saved = process.env.FASTINO_API_KEY;
    delete process.env.FASTINO_API_KEY;
    expect(await routeMessage({ app: CARP, question: "q" })).toBeNull();
    if (saved !== undefined) process.env.FASTINO_API_KEY = saved;
  });
});

describe("the decision policy", () => {
  test("a confident off-topic message and a greeting skip the model; everything else does not", () => {
    expect(shortcutFor(route({ intent: "off_topic", onTopic: 0.01 }), "capital of France")).toBe("off_topic");
    expect(shortcutFor(route({ intent: "off_topic", onTopic: 0.4 }), "x")).toBeNull();
    expect(shortcutFor(route({ intent: "off_topic", intentConfidence: 0.8, onTopic: 0.01 }), "x")).toBeNull();
    expect(shortcutFor(route({ intent: "greeting_or_help" }), "hello what can you do")).toBe("greeting");
    expect(shortcutFor(route({ intent: "greeting_or_help" }), "hello ".repeat(30))).toBeNull();
    expect(shortcutFor(route(), "How many silver carp?")).toBeNull();
    expect(INTENTS).toContain("map_control");
  });

  test("replies name the app's own subject and example questions, for every app", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      expect(offTopicReply(app)).toMatch(/I only cover/);
      expect(offTopicReply(app).match(/“/g)?.length).toBe(3);
      expect(greetingReply(app)).toMatch(/field agent/);
    }
  });

  test("the hint is plainly a guess and only comes with some confidence", () => {
    expect(hintFor(route())).toMatch(/not evidence/);
    expect(hintFor(route())).toContain("carp_sightings, geocode");
    expect(hintFor(route({ intentConfidence: 0.3 }))).toBeNull();
    expect(hintFor(route({ suggestedTools: [] }))).not.toContain("Tools that");
  });
});
