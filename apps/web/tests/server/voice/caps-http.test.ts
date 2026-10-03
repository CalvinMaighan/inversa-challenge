import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST as openRoute } from "@/app/api/voice/session/route";
import type { AgentRunner } from "server/voice/agent-runner";
import { IpRateLimiter, utcDay, VOICE_USAGE_FILE, VoiceBudget, voiceLimitsFromEnv, type VoiceLimits } from "server/voice/budget";
import { clientIp, handleAudio, handleControl, handleEvents, handleOpenSession, MAX_AUDIO_CHARS } from "server/voice/http";
import { VoiceSessionRegistry } from "server/voice/voice-sessions";
import { VOICE_DAILY_MINUTES, VOICE_MAX_SESSION_MS, VOICE_TOKEN_HEADER, type VoiceSessionOpenResponse } from "shared/voice/protocol";

import { startMockXai, type MockXai } from "./mock-xai";

const idleRunner: AgentRunner = { run: () => new Promise(() => undefined) };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "voice-caps-"));
}

function limits(overrides: Partial<VoiceLimits> = {}): VoiceLimits {
  return { dataDir: tempDir(), maxSessionMs: 60_000, dailyMinutes: 60, ipSessionsPerHour: 20, maxLiveSessions: 4, ...overrides };
}

function registryWith(mock: MockXai | null, l: VoiceLimits): VoiceSessionRegistry {
  const registry = new VoiceSessionRegistry({
    limits: l,
    runner: idleRunner,
    target: () => (mock ? { url: mock.url, apiKey: "test-key-not-real" } : null),
  });
  cleanups.push(() => registry.closeAll("test"));
  return registry;
}

function mockXai(): MockXai {
  const mock = startMockXai();
  cleanups.push(() => mock.stop());
  return mock;
}

const openRequest = (ip = "203.0.113.7") =>
  new Request("http://localhost/api/voice/session?app=python", { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` }, body: "{}" });

async function openOk(registry: VoiceSessionRegistry, ip?: string): Promise<VoiceSessionOpenResponse> {
  const res = await handleOpenSession(openRequest(ip), registry);
  expect(res.status).toBe(200);
  return (await res.json()) as VoiceSessionOpenResponse;
}

describe("voice caps", () => {
  test("daily voice cap", async () => {
    const l = limits({ dailyMinutes: 1 });
    writeFileSync(path.join(l.dataDir, VOICE_USAGE_FILE), JSON.stringify({ day: utcDay(Date.now()), usedMs: 60_000 }));
    const mock = mockXai();
    const registry = registryWith(mock, l);

    const res = await handleOpenSession(openRequest(), registry);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toContain("Daily voice minutes");
    // Refused before any provider socket was opened.
    expect(mock.authHeaders).toHaveLength(0);

    // The route file is wired to the process registry and returns the same 429.
    const g = globalThis as unknown as { __inversaVoiceRegistryV2?: VoiceSessionRegistry };
    const saved = g.__inversaVoiceRegistryV2;
    g.__inversaVoiceRegistryV2 = registry;
    try {
      expect((await openRoute(openRequest())).status).toBe(429);
    } finally {
      g.__inversaVoiceRegistryV2 = saved;
    }

    // Under the cap the same registry opens a session.
    const fresh = registryWith(mock, limits({ dailyMinutes: 1 }));
    const payload = await openOk(fresh);
    expect(payload.inputSampleRate).toBe(16_000);
    expect(payload.outputSampleRate).toBe(24_000);
    expect(payload.token.length).toBeGreaterThan(20);
  });

  test("a live session is closed when the daily budget runs out", async () => {
    const mock = mockXai();
    const l = limits({ dailyMinutes: 1 });
    const registry = registryWith(mock, l);
    const payload = await openOk(registry);
    const session = registry.get(payload.sessionId, payload.token)!;
    const reasons: string[] = [];
    session.subscribe((e) => {
      if (e.type === "session.closed") reasons.push(e.reason);
    });
    registry.budget.charge(60_000);
    (session as unknown as { meterTick(): void }).meterTick();
    expect(reasons).toEqual(["daily_budget"]);
    expect(registry.get(payload.sessionId, payload.token)).toBeNull();
  });

  test("usage persists across restarts and resets on a new UTC day", () => {
    const dir = tempDir();
    let now = Date.parse("2026-09-30T23:59:00Z");
    const budget = new VoiceBudget({ dataDir: dir, dailyMinutes: 2, now: () => now });
    budget.charge(90_000);
    expect(budget.remainingMs()).toBe(30_000);
    const saved = JSON.parse(readFileSync(path.join(dir, VOICE_USAGE_FILE), "utf8")) as { day: string; usedMs: number };
    expect(saved).toEqual({ day: "2026-09-30", usedMs: 90_000 });

    const restarted = new VoiceBudget({ dataDir: dir, dailyMinutes: 2, now: () => now });
    expect(restarted.usedTodayMs()).toBe(90_000);
    restarted.charge(30_000);
    expect(restarted.exhausted()).toBe(true);

    now = Date.parse("2026-10-01T00:00:01Z");
    expect(restarted.exhausted()).toBe(false);
    expect(restarted.usedTodayMs()).toBe(0);
  });

  test("a corrupt usage file starts the day at zero", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, VOICE_USAGE_FILE), "{not json");
    expect(new VoiceBudget({ dataDir: dir, dailyMinutes: 1 }).usedTodayMs()).toBe(0);
  });

  test("per-IP rate limit returns 429 with Retry-After", async () => {
    const mock = mockXai();
    const registry = registryWith(mock, limits({ ipSessionsPerHour: 2 }));
    await openOk(registry, "198.51.100.1");
    await openOk(registry, "198.51.100.1");
    const res = await handleOpenSession(openRequest("198.51.100.1"), registry);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3_500);
    // Another client is unaffected.
    await openOk(registry, "198.51.100.2");
  });

  test("a second session from one IP replaces the first", async () => {
    const mock = mockXai();
    const registry = registryWith(mock, limits());
    const first = await openOk(registry);
    const second = await openOk(registry);
    expect(registry.get(first.sessionId, first.token)).toBeNull();
    expect(registry.get(second.sessionId, second.token)).not.toBeNull();
  });

  test("the live-session cap returns 429", async () => {
    const mock = mockXai();
    const registry = registryWith(mock, limits({ maxLiveSessions: 1 }));
    await openOk(registry, "192.0.2.1");
    expect((await handleOpenSession(openRequest("192.0.2.2"), registry)).status).toBe(429);
  });

  test("the session hard cap closes the session", async () => {
    const mock = mockXai();
    const registry = registryWith(mock, limits({ maxSessionMs: 40 }));
    const payload = await openOk(registry);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.get(payload.sessionId, payload.token)).toBeNull();
  });

  test("unconfigured voice returns 503", async () => {
    const res = await handleOpenSession(openRequest(), registryWith(null, limits()));
    expect(res.status).toBe(503);
  });

  test("limits read env overrides and fall back to the protocol caps", () => {
    expect(voiceLimitsFromEnv({})).toMatchObject({
      dataDir: "./data",
      maxSessionMs: VOICE_MAX_SESSION_MS,
      dailyMinutes: VOICE_DAILY_MINUTES,
    });
    expect(
      voiceLimitsFromEnv({ INVERSA_DATA_DIR: "/srv/inversa", VOICE_MAX_SESSION_MS: "120000", VOICE_DAILY_MINUTES: "15" }),
    ).toMatchObject({ dataDir: "/srv/inversa", maxSessionMs: 120_000, dailyMinutes: 15 });
    expect(voiceLimitsFromEnv({ VOICE_DAILY_MINUTES: "-3", VOICE_MAX_SESSION_MS: "abc" })).toMatchObject({
      maxSessionMs: VOICE_MAX_SESSION_MS,
      dailyMinutes: VOICE_DAILY_MINUTES,
    });
  });

  test("ip limiter prunes expired windows", () => {
    let now = 0;
    const limiter = new IpRateLimiter(1, () => now);
    expect(limiter.tryOpen("a")).toBe(true);
    expect(limiter.tryOpen("a")).toBe(false);
    now = 3_600_000;
    limiter.prune();
    expect(limiter.tryOpen("a")).toBe(true);
  });

  test("client ip comes from the first forwarded hop", () => {
    expect(clientIp(openRequest("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "192.0.2.5" } }))).toBe("192.0.2.5");
    expect(clientIp(new Request("http://x"))).toBe("local");
  });
});

describe("voice session endpoints", () => {
  async function live() {
    const mock = mockXai();
    const registry = registryWith(mock, limits());
    const payload = await openOk(registry);
    const call = (suffix: string, init: RequestInit & { token?: string } = {}) =>
      new Request(`http://localhost/api/voice/session/${payload.sessionId}${suffix}`, {
        ...init,
        headers: { "content-type": "application/json", [VOICE_TOKEN_HEADER]: init.token ?? payload.token },
      });
    return { mock, registry, payload, call };
  }

  test("token is required on audio, control and events", async () => {
    const { registry, payload, call } = await live();
    const bad = { token: "x".repeat(payload.token.length) };
    expect((await handleAudio(call("/audio", { method: "POST", body: '{"audio":"AAAA"}', ...bad }), payload.sessionId, registry)).status).toBe(404);
    expect((await handleControl(call("/control", { method: "POST", body: '{"type":"interrupt"}', ...bad }), payload.sessionId, registry)).status).toBe(404);
    expect(handleEvents(call("/events", bad), payload.sessionId, registry).status).toBe(404);
    expect((await handleAudio(call("/audio", { method: "POST", body: '{"audio":"AAAA"}' }), "nope", registry)).status).toBe(404);
  });

  test("audio batches are forwarded to the provider and oversized ones refused", async () => {
    const { mock, registry, payload, call } = await live();
    const ok = await handleAudio(call("/audio", { method: "POST", body: JSON.stringify({ audio: "AAAA" }) }), payload.sessionId, registry);
    expect(ok.status).toBe(204);
    const appended = await mock.waitFor((e) => e.type === "input_audio_buffer.append");
    expect(appended.audio).toBe("AAAA");
    const big = await handleAudio(
      call("/audio", { method: "POST", body: JSON.stringify({ audio: "A".repeat(MAX_AUDIO_CHARS + 4) }) }),
      payload.sessionId,
      registry,
    );
    expect(big.status).toBe(413);
    expect((await handleAudio(call("/audio", { method: "POST", body: "{}" }), payload.sessionId, registry)).status).toBe(400);
  });

  test("control accepts protocol requests and view_state, rejects the rest", async () => {
    const { mock, registry, payload, call } = await live();
    const post = (body: unknown) => handleControl(call("/control", { method: "POST", body: JSON.stringify(body) }), payload.sessionId, registry);
    expect((await post({ type: "view_state", state: { camera: { place: "Flamingo" } } })).status).toBe(204);
    expect((await post({ type: "view_state", state: [1, 2] })).status).toBe(400);
    expect((await post({ type: "view_state" })).status).toBe(400);
    expect((await post({ type: "reboot" })).status).toBe(400);
    expect((await post({ type: "text", text: "x".repeat(4_001) })).status).toBe(400);
    expect((await post({ type: "mode", mode: "talk" })).status).toBe(204);
    expect((await post({ type: "playback", responseId: "r1", state: "started" })).status).toBe(204);
    expect((await post({ type: "text", text: "fly to Key West" })).status).toBe(204);
    const typed = await mock.waitFor((e) => e.type === "conversation.item.create");
    expect(JSON.stringify(typed.item)).toContain("fly to Key West");
    expect((await post({ type: "interrupt" })).status).toBe(204);
    await mock.waitFor((e) => e.type === "response.cancel");
    expect((await post({ type: "close" })).status).toBe(204);
    expect(registry.get(payload.sessionId, payload.token)).toBeNull();
  });

  test("events stream is NDJSON starting with voice.ready and ends on close", async () => {
    const { registry, payload, call } = await live();
    const res = handleEvents(call("/events"), payload.sessionId, registry);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    registry.get(payload.sessionId, payload.token)!.close("user");
    const lines = (await res.text()).split("\n").filter((line) => line.trim());
    const events = lines.map((line) => JSON.parse(line) as { type: string; reason?: string });
    expect(events[0]).toMatchObject({ type: "voice.ready", sessionId: payload.sessionId });
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "user" });
  });
});
