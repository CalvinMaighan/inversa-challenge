import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import * as timer from "@deepseek-ai/cordis-plugin-timer";
import * as agent from "@deepseek-ai/dsh-agent";
import * as agentDefaultModel from "@deepseek-ai/dsh-agent-default-model";
import * as agentLoop from "@deepseek-ai/dsh-agent-loop";
import { assertEntriesActivated, boot } from "@deepseek-ai/dsh-app-boot";
import * as compactionBasic from "@deepseek-ai/dsh-compaction-basic";
import * as toolResultPruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import * as credentialsLocal from "@deepseek-ai/dsh-credentials-local";
import * as llm from "@deepseek-ai/dsh-llm";
import * as llmRetry from "@deepseek-ai/dsh-llm-retry";
import * as session from "@deepseek-ai/dsh-session";
import * as settingsFile from "@deepseek-ai/dsh-settings-file";
import * as systemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as tokenMeter from "@deepseek-ai/dsh-token-meter";
import * as tools from "@deepseek-ai/dsh-tools";

import { ensureAgentDshHome } from "@/server/agent/cordis/home";
import * as fireworks from "@/server/agent/cordis/plugins/llm-openai-compat";
import * as mockLlm from "@/server/agent/cordis/plugins/mock-llm";
import { FLASH_CATALOG_ID, PRO_CATALOG_ID } from "@/server/agent/runtime/model";

const BIN = "inversa-agent";

/**
 * Every package cordis.yml names, imported statically. The Loader normally
 * `import()`s entry names at runtime, which a bundler (Next/Turbopack) cannot
 * follow; handing it these namespaces keeps cordis.yml the source of truth
 * while the modules stay visible to the bundler.
 */
const PLUGIN_MODULES: Record<string, unknown> = {
  "@deepseek-ai/cordis-plugin-timer": timer,
  "@deepseek-ai/dsh-llm": llm,
  "@deepseek-ai/dsh-session": session,
  "@deepseek-ai/dsh-agent": agent,
  "@deepseek-ai/dsh-agent-default-model": agentDefaultModel,
  "@deepseek-ai/dsh-llm-retry": llmRetry,
  "@deepseek-ai/dsh-settings-file": settingsFile,
  "@deepseek-ai/dsh-credentials-local": credentialsLocal,
  "@deepseek-ai/dsh-token-meter": tokenMeter,
  "@deepseek-ai/dsh-compaction-basic": compactionBasic,
  "@deepseek-ai/dsh-compaction-tool-result-pruner": toolResultPruner,
  "@deepseek-ai/dsh-tools": tools,
  "@deepseek-ai/dsh-system-prompt": systemPrompt,
  "@deepseek-ai/dsh-agent-loop": agentLoop,
};

/** apps/web is the cwd for `next dev`, `next start`, `bun test` and `bun run eval`. */
function configPath(): string {
  return (
    process.env.AGENT_CORDIS_CONFIG?.trim() ||
    join(/*turbopackIgnore: true*/ process.cwd(), "server/agent/cordis/cordis.yml")
  );
}

/** Resolve cordis.yml entry names from PLUGIN_MODULES; an unlisted name fails loudly. */
function installStaticModules(ctx: Context): void {
  const native = ctx.loader.internal;
  const moduleLoader = {
    async import(specifier: string, parentURL: string, attributes: ImportAttributes) {
      if (specifier in PLUGIN_MODULES) return PLUGIN_MODULES[specifier];
      if (native) return native.import(specifier, parentURL, attributes);
      throw new Error(`cordis.yml names "${specifier}", which is not in PLUGIN_MODULES (server/agent/cordis/boot.ts)`);
    },
  };
  // The Loader only calls `import` on its module loader for entry resolution.
  ctx.loader.internal = moduleLoader as unknown as typeof ctx.loader.internal;
}

export type HarnessMode = "live" | "mock";

let liveBoot: Promise<Context> | undefined;
let mockBoot: Promise<Context> | undefined;

function formatPluginTreeError(error: unknown): Error {
  const messages: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (value == null || depth > 8 || !(value instanceof Error)) return;
    messages.push(value.message);
    if ("errors" in value && Array.isArray(value.errors)) {
      for (const inner of value.errors) walk(inner, depth + 1);
    }
    walk(value.cause, depth + 1);
  };
  walk(error, 0);
  return new Error([...new Set(messages)].join(" — ") || "plugin tree failed to load", { cause: error });
}

async function mountHarness(mode: HarnessMode): Promise<Context> {
  ensureAgentDshHome();
  let ctx: Context;
  try {
    ctx = await boot(BIN, configPath(), undefined, installStaticModules);
  } catch (error) {
    throw formatPluginTreeError(error);
  }
  await ctx.plugin(mode === "mock" ? mockLlm : fireworks);
  await assertEntriesActivated(ctx, BIN);
  return ctx;
}

/** One cached root context per mode. Concurrent callers share the boot. */
export function bootHarness(mode: HarnessMode = "live"): Promise<Context> {
  if (mode === "mock") {
    mockBoot ??= mountHarness("mock").catch((error: unknown) => {
      mockBoot = undefined;
      throw error;
    });
    return mockBoot;
  }
  liveBoot ??= mountHarness("live").catch((error: unknown) => {
    liveBoot = undefined;
    throw error;
  });
  return liveBoot;
}

/** Test-only: drop cached contexts so the next boot is fresh. */
export async function resetHarness(): Promise<void> {
  const pending = [liveBoot, mockBoot];
  liveBoot = undefined;
  mockBoot = undefined;
  for (const booted of pending) {
    if (!booted) continue;
    try {
      await (await booted).fiber.dispose();
    } catch {
      // Boot failed; nothing to dispose.
    }
  }
}

type ModelEntry = { provider: string; model: string };

/** Read a model row from the loaded cordis.yml, including disabled rows. */
function configuredModel(ctx: Context, entryId: string): ModelEntry | undefined {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.id !== entryId) continue;
    const config = entry.options.config as Partial<ModelEntry> | undefined;
    if (typeof config?.provider === "string" && typeof config.model === "string") {
      return { provider: config.provider, model: config.model };
    }
  }
  return undefined;
}

/** The default and escalation models declared in cordis.yml. */
export function harnessModels(ctx: Context): { primary: ModelEntry; escalation: ModelEntry } {
  return {
    primary: configuredModel(ctx, "agent-default-model") ?? { provider: "fireworks", model: FLASH_CATALOG_ID },
    escalation: configuredModel(ctx, "agent-escalation-model") ?? { provider: "fireworks", model: PRO_CATALOG_ID },
  };
}
