import { describe, expect, test } from "bun:test";

import { handleOpenSession } from "server/voice/http";
import { buildVoiceInstructions, greetingInstructions, WELCOME_LINE } from "server/voice/voice-prompt";
import type { VoiceSessionRegistry } from "server/voice/voice-sessions";
import { APP_IDS, getApp } from "shared/apps";

describe("first-run welcome", () => {
  test("the welcome greeting is the one fixed sentence, word for word, for every app", () => {
    expect(WELCOME_LINE).toBe("Welcome to the Inversa Experience, I'm your voice assistant, how may I help you today?");
    for (const id of APP_IDS) {
      const text = greetingInstructions(getApp(id), { welcome: true });
      expect(text).toContain(`"${WELCOME_LINE}"`);
      expect(text).toMatch(/exactly this sentence, word for word/);
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

describe("what the voice hears", () => {
  test("the persona tells the voice that carb, carbs and karp in the transcript mean carp, in every app", () => {
    for (const id of APP_IDS) {
      const text = buildVoiceInstructions(getApp(id));
      expect(text).toContain("# What you hear");
      expect(text).toMatch(/"carb", "carbs", "karp" or "car"[^.]*means carp/);
      expect(text).toMatch(/never repeat the misheard spelling back/);
    }
  });
});
