import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { POST, dynamic, maxDuration, runtime } from "@/app/api/agent/stream/route";

/** Route checks that need no model: config, request validation, and the missing-key 503. */

const savedKey = process.env.OPENROUTER_API_KEY;

beforeAll(() => {
  delete process.env.OPENROUTER_API_KEY;
});

afterAll(() => {
  if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/agent/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/agent/stream", () => {
  test("route config is nodejs and dynamic", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBeGreaterThan(90);
  });

  test("rejects a malformed request with 400 before streaming", async () => {
    expect((await post("{not json")).status).toBe(400);
    const missing = await post({ sessionId: "x", question: "   " });
    expect(missing.status).toBe(400);
    const badSession = await post({ sessionId: "../etc/passwd", question: "hi" });
    expect(badSession.status).toBe(400);
    const tooLong = await post({ sessionId: "ok", question: "x".repeat(4_001) });
    expect(tooLong.status).toBe(400);
    const badView = await post({
      sessionId: "ok",
      question: "hi",
      view: { bbox: { west: 1, south: 1, east: 0, north: 2 }, time: "yesterday-ish", layers: [], selection: null },
    });
    expect(badView.status).toBe(400);
    const body = (await badView.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Invalid agent request");
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
  });

  test("503 with a clear JSON error when OPENROUTER_API_KEY is not set", async () => {
    const response = await post({ sessionId: "no-key", question: "Any alerts over Florida Bay?" });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "agent unavailable: OPENROUTER_API_KEY not set" });
  });

  test("a blank OPENROUTER_API_KEY counts as missing (503)", async () => {
    process.env.OPENROUTER_API_KEY = "   ";
    try {
      expect((await post({ sessionId: "blank-key", question: "hi" })).status).toBe(503);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
