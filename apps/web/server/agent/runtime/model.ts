/**
 * The agent's one model: GPT-6 Luna through OpenRouter's OpenAI-compatible API.
 * cordis.yml names it (`agent-default-model`); this module owns the wire route.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenRouter model id, as written in cordis.yml and sent on the wire. */
export const AGENT_MODEL_ID = "openai/gpt-6-luna";

/** OpenRouter app attribution. */
export const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://inversa.calvinmaighan.dev",
  "X-Title": "Everglades Ops",
} as const;

export const MISSING_KEY_MESSAGE = "agent unavailable: OPENROUTER_API_KEY not set";

/** OpenRouter `reasoning.effort` values the agent uses. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export type AgentLlmEndpoint = {
  provider: "openrouter";
  model: string;
  baseUrl: string;
  contextWindow: number;
  /** Output cap. Reasoning tokens count against it. */
  maxTokens: number;
  reasoningEffort: ReasoningEffort;
};

const LUNA: AgentLlmEndpoint = {
  provider: "openrouter",
  model: AGENT_MODEL_ID,
  baseUrl: OPENROUTER_BASE_URL,
  contextWindow: 1_050_000,
  maxTokens: 16_384,
  reasoningEffort: "low",
};

/**
 * Reasoning effort per app, when one differs from the endpoint default. Measured on carp: `medium` passed the
 * benchmark no more often than `low` (68/69 vs 66-69/69) and pushed first-token p50 from 1.3 s to 1.9 s;
 * `minimal` did not lower it (1.3 s), so every app stays on `low`.
 */
const EFFORT_BY_APP: Partial<Record<string, ReasoningEffort>> = {};

export function resolveAgentEndpoint(modelId: string, appId?: string): AgentLlmEndpoint {
  if (modelId.trim() !== AGENT_MODEL_ID) throw new Error(`Unknown agent model: ${modelId} (only ${AGENT_MODEL_ID})`);
  const effort = appId ? EFFORT_BY_APP[appId] : undefined;
  return effort ? { ...LUNA, reasoningEffort: effort } : LUNA;
}

export function openRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || undefined;
}
