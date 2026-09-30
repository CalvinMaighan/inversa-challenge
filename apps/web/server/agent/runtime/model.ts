/**
 * Catalog id to Fireworks wire route. Ids match deedee
 * `shared/providers/fireworks/fireworks-models.ts`.
 */

export const FIREWORKS_OPENAI_BASE_URL = "https://api.fireworks.ai/inference/v1";

export type AgentModelTier = "flash" | "pro";

export type AgentLlmEndpoint = {
  tier: AgentModelTier;
  /** Catalog id, as written in cordis.yml. */
  catalogId: string;
  provider: "fireworks";
  /** Wire id sent to Fireworks. */
  model: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  /** Fireworks `reasoning_effort` for DeepSeek v4. */
  reasoningEffort: "none" | "low" | "medium" | "high";
};

/** Default model (cordis.yml `agent-default-model`). */
export const FLASH_CATALOG_ID = "deepseek-v4-flash";
/** Escalation model (cordis.yml `agent-escalation-model`). */
export const PRO_CATALOG_ID = "deepseek-v4-pro-0813";

const ENDPOINTS: Record<string, AgentLlmEndpoint> = {
  [FLASH_CATALOG_ID]: {
    tier: "flash",
    catalogId: FLASH_CATALOG_ID,
    provider: "fireworks",
    model: "accounts/fireworks/models/deepseek-v4p1-flash",
    baseUrl: FIREWORKS_OPENAI_BASE_URL,
    contextWindow: 160_000,
    maxTokens: 8_192,
    reasoningEffort: "low",
  },
  [PRO_CATALOG_ID]: {
    tier: "pro",
    catalogId: PRO_CATALOG_ID,
    provider: "fireworks",
    model: "accounts/fireworks/models/deepseek-v4-pro-0813",
    baseUrl: FIREWORKS_OPENAI_BASE_URL,
    contextWindow: 1_048_576,
    maxTokens: 8_192,
    reasoningEffort: "medium",
  },
};

/** Accepts a catalog id, the `deepseek-v4-pro` alias, or a Fireworks wire id. */
export function resolveAgentEndpoint(modelId: string): AgentLlmEndpoint {
  const id = modelId.trim() === "deepseek-v4-pro" ? PRO_CATALOG_ID : modelId.trim();
  const found =
    ENDPOINTS[id] ??
    Object.values(ENDPOINTS).find((endpoint) => endpoint.model === id || endpoint.model.split("/").pop() === id);
  if (!found) throw new Error(`Unknown agent model: ${modelId}`);
  // FIREWORKS_BASE_URL points the adapter at a proxy or a local OpenAI-compatible fake.
  return { ...found, baseUrl: process.env.FIREWORKS_BASE_URL?.trim() || found.baseUrl };
}

export function fireworksApiKey(): string | undefined {
  return process.env.FIREWORKS_API_KEY?.trim() || undefined;
}
