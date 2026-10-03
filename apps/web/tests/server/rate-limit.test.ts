import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST as agentRoute } from "@/app/api/agent/stream/route";
import { POST as voiceRoute } from "@/app/api/voice/session/route";
import { clientIp, DEFAULT_RATE_PER_MIN, SlidingWindowLimiter } from "@/server/rate-limit";
import { defaultAgentRunner } from "@/server/voice/agent-runner";
import { VoiceSessionRegistry } from "@/server/voice/voice-sessions";

/**
 * Per-IP rate limits on the two routes that spend money (docs/security.md): the 11th request from one
 * address inside a minute answers 429 with Retry-After, while another address is unaffected. The requests
 * are cheap on purpose (bad JSON, voice without a provider), so nothing here reaches a model or a socket.
 */

const g = globalThis as unknown as { __inversaVoiceRegistryV3?: VoiceSessionRegistry };
const savedRegistry = g.__inversaVoiceRegistryV3;
const dataDir = mkdtempSync(path.join(tmpdir(), "inversa-rate-limit-"));

beforeAll(() => {
  // No provider target: every voice open under the limit answers 503 without opening a socket.
  g.__inversaVoiceRegistryV3 = new VoiceSessionRegistry({
    limits: { dataDir, maxSessionMs: 60_000, dailyMinutes: 10, ipSessionsPerHour: 1_000, maxLiveSessions: 4 },
    runner: defaultAgentRunner,
    target: () => null,
  });
});

afterAll(() => {
  g.__inversaVoiceRegistryV3 = savedRegistry;
  rmSync(dataDir, { recursive: true, force: true });
});

const agentPost = (ip: string) =>
  agentRoute(new Request("http://localhost/api/agent/stream", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` }, body: "{not json" }));
const voicePost = (ip: string) => voiceRoute(new Request("http://localhost/api/voice/session?app=python", { method: "POST", headers: { "x-forwarded-for": ip }, body: "{}" }));

describe("rate limit", () => {
  test("rate limit: /api/agent/stream answers the 11th request from one IP within a minute with 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < DEFAULT_RATE_PER_MIN; i++) statuses.push((await agentPost("198.51.100.20")).status);
    expect(statuses).toEqual(Array(DEFAULT_RATE_PER_MIN).fill(400));
    const eleventh = await agentPost("198.51.100.20");
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(eleventh.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(((await eleventh.json()) as { error: string }).error).toContain("Too many requests");
    // Another address keeps its own budget.
    expect((await agentPost("198.51.100.21")).status).toBe(400);
  });

  test("rate limit: /api/voice/session answers the 11th request from one IP within a minute with 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < DEFAULT_RATE_PER_MIN; i++) statuses.push((await voicePost("198.51.100.30")).status);
    expect(statuses).toEqual(Array(DEFAULT_RATE_PER_MIN).fill(503));
    const eleventh = await voicePost("198.51.100.30");
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("retry-after")).not.toBeNull();
    expect((await voicePost("198.51.100.31")).status).toBe(503);
  });

  test("rate limit window slides: requests leave it after a minute, refused ones are not counted", () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(2, 60_000, () => now);
    expect(limiter.hit("a").ok).toBe(true);
    now += 30_000;
    expect(limiter.hit("a").ok).toBe(true);
    const refused = limiter.hit("a");
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 30 });
    now += 30_000; // the first request left the window
    expect(limiter.hit("a").ok).toBe(true);
    expect(limiter.hit("a").ok).toBe(false);
    now += 120_000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });

  test("rate limit key is the first X-Forwarded-For hop, then X-Real-IP, else one local bucket", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" } }))).toBe("203.0.113.4");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "192.0.2.9" } }))).toBe("192.0.2.9");
    expect(clientIp(new Request("http://x"))).toBe("local");
  });
});
