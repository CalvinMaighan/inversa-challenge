import { afterAll, describe, expect, test } from "bun:test";

import { bootHarness, harnessModel, resetHarness } from "@/server/agent/cordis/boot";

describe("agent cordis spine", () => {
  afterAll(async () => {
    await resetHarness();
  });

  test("boots and activates required services", async () => {
    const ctx = await bootHarness();
    expect(ctx.llm).toBeDefined();
    expect(ctx.sessions).toBeDefined();
    expect(ctx.agents).toBeDefined();
    expect(ctx.tools).toBeDefined();
    expect(ctx.systemPrompt).toBeDefined();
    expect(ctx.llm.listProviders().map((provider) => provider.id)).toEqual(["openrouter"]);
  });

  test("cordis.yml declares one model: gpt-6-luna on openrouter", async () => {
    const ctx = await bootHarness();
    expect(harnessModel(ctx)).toEqual({ provider: "openrouter", model: "openai/gpt-6-luna" });
    const modelRows = [...ctx.loader.entries()].filter((entry) => entry.options.name === "@deepseek-ai/dsh-agent-default-model");
    expect(modelRows).toHaveLength(1);
  });

  test("concurrent boots share one context", async () => {
    const [a, b] = await Promise.all([bootHarness(), bootHarness()]);
    expect(a).toBe(b);
  });
});
