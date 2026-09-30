import { afterAll, describe, expect, test } from "bun:test";

import { bootHarness, harnessModels, resetHarness } from "@/server/agent/cordis/boot";

describe("agent cordis spine", () => {
  afterAll(async () => {
    await resetHarness();
  });

  test("boots and activates required services", async () => {
    const ctx = await bootHarness("mock");
    expect(ctx.llm).toBeDefined();
    expect(ctx.sessions).toBeDefined();
    expect(ctx.agents).toBeDefined();
    expect(ctx.tools).toBeDefined();
    expect(ctx.systemPrompt).toBeDefined();
    expect(ctx.llm.listProviders().map((provider) => provider.id)).toEqual(["fireworks"]);
  });

  test("cordis.yml declares flash with pro escalation", async () => {
    const ctx = await bootHarness("mock");
    expect(harnessModels(ctx)).toEqual({
      primary: { provider: "fireworks", model: "deepseek-v4-flash" },
      escalation: { provider: "fireworks", model: "deepseek-v4-pro-0813" },
    });
  });

  test("concurrent boots share one context", async () => {
    const [a, b] = await Promise.all([bootHarness("mock"), bootHarness("mock")]);
    expect(a).toBe(b);
  });
});
