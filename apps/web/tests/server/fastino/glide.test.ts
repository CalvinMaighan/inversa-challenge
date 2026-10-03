import { beforeEach, describe, expect, test } from "bun:test";

import { decide, glide, glideAvailable, GlideError, resetGlideBreaker, type NoulQuestion } from "@/server/fastino/glide";

const Q = { ok: { type: "noul", instructions: "Is it fine?" } satisfies NoulQuestion };
const answer = (noul: number) => ({ model: "glide", answers: { ok: { type: "noul", noul, confidence: Math.abs(2 * noul - 1) } }, usage: { input_tokens: 12, output_tokens: 1 } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const now = async () => undefined;

beforeEach(() => resetGlideBreaker());

describe("glide", () => {
  test("posts the model, state and questions to /v1/systemone with the key in X-API-Key", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return json(answer(0.9));
    }) as unknown as typeof fetch;
    const out = await glide({ message: "hi" }, Q, { apiKey: "fast_sk_test", fetchImpl });
    expect(seen!.url).toBe("https://api.fastino.ai/v1/systemone");
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("fast_sk_test");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ model: "fastino/GLiDE", state: { message: "hi" }, questions: Q });
    expect(out.answers.ok.noul).toBe(0.9);
    expect(out.inputTokens).toBe(12);
  });

  test("retries a 429 once, honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? json({ error: { message: "slow down" } }, 429, { "retry-after": "1" }) : json(answer(0.2)))) as unknown as typeof fetch;
    const out = await glide("s", Q, { apiKey: "k", fetchImpl, sleep: now });
    expect(calls).toBe(2);
    expect(out.answers.ok.noul).toBe(0.2);
  });

  test("a 401 is a typed error that carries the status and API message, not the key or the request", async () => {
    const fetchImpl = (async () => json({ error: { message: "Invalid API key" } }, 401)) as unknown as typeof fetch;
    const error = await glide("secret state", Q, { apiKey: "fast_sk_secret", fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlideError);
    expect((error as GlideError).status).toBe(401);
    expect(String((error as Error).message)).not.toContain("fast_sk_secret");
    expect(String((error as Error).message)).not.toContain("secret state");
  });

  test("a missing question in the answer is an error", async () => {
    const fetchImpl = (async () => json({ answers: {} })) as unknown as typeof fetch;
    await expect(glide("s", Q, { apiKey: "k", fetchImpl })).rejects.toThrow(/unanswered/);
  });
});

describe("decide", () => {
  test("is null without a key, and never calls the network", async () => {
    const saved = process.env.FASTINO_API_KEY;
    delete process.env.FASTINO_API_KEY;
    let calls = 0;
    const fetchImpl = (async () => (calls++, json(answer(1)))) as unknown as typeof fetch;
    expect(glideAvailable()).toBe(false);
    expect(await decide("s", Q, { fetchImpl })).toBeNull();
    expect(calls).toBe(0);
    if (saved !== undefined) process.env.FASTINO_API_KEY = saved;
  });

  test("three failures in a row stop the calls for a while (the breaker), a success resets the count", async () => {
    let calls = 0;
    const failing = (async () => (calls++, json({ error: { message: "down" } }, 500))) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) expect(await decide("s", Q, { apiKey: "k", fetchImpl: failing })).toBeNull();
    expect(calls).toBe(3);
    expect(glideAvailable("k")).toBe(false);
    expect(await decide("s", Q, { apiKey: "k", fetchImpl: failing })).toBeNull();
    expect(calls).toBe(3);
  });
});
