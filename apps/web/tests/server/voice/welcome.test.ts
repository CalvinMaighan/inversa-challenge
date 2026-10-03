import { describe, expect, test } from "bun:test";

import { handleOpenSession } from "server/voice/http";
import { buildVoiceInstructions, greetingInstructions } from "server/voice/voice-prompt";
import type { VoiceSessionRegistry } from "server/voice/voice-sessions";
import { APP_IDS, getApp } from "shared/apps";

describe("first-run welcome", () => {
  test("the welcome greeting names the Inversa Experience, asks how to help and points at the dots", () => {
    for (const id of APP_IDS) {
      const text = greetingInstructions(getApp(id), { welcome: true });
      expect(text).toContain("Inversa Experience");
      expect(text).toMatch(/how you can help/);
      expect(text).toMatch(/click any dot/);
      expect(text).toContain(getApp(id).taxa[0]?.name ?? "Asian carp");
      expect(text).toMatch(/Do not call tools/);
    }
  });

  test("without the flag the greeting stays the short listening line", () => {
    const text = greetingInstructions(getApp(APP_IDS[2]));
    expect(text).toMatch(/listening/);
    expect(text).not.toContain("Inversa Experience");
  });

  test("the persona recommends clicking dots and reminds once about the source website", () => {
    const text = buildVoiceInstructions(getApp(APP_IDS[0]));
    expect(text).toMatch(/click any dot on the globe/);
    expect(text).toMatch(/website it came from/);
    expect(text).toMatch(/Say it once/);
  });

  test("welcome=1 on the open request reaches the registry", async () => {
    const seen: unknown[] = [];
    const registry = { open: async (_ip: string, _app: unknown, opts: unknown) => (seen.push(opts), { ok: false as const, status: 503, error: "off" }) } as unknown as VoiceSessionRegistry;
    const req = (q: string) => new Request(`http://x/api/voice/session?${q}`, { method: "POST" });
    await handleOpenSession(req("app=carp&welcome=1"), registry);
    await handleOpenSession(req("app=carp"), registry);
    expect(seen).toEqual([{ welcome: true }, { welcome: false }]);
  });
});
