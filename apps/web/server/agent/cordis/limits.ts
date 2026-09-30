import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

/** Per-turn guardrails (PRD §10 "Limits"). The model decides completion; these bound it. */
export type AgentLimits = { maxTurns: number; maxToolCalls: number; maxRuntimeMs: number };

export const AGENT_LIMITS: AgentLimits = { maxTurns: 12, maxToolCalls: 30, maxRuntimeMs: 90_000 };

export type LimitHit = { kind: "turns" | "tool_calls" | "runtime"; limit: number };

/**
 * deedee `limits.ts`: deny tool calls past the cap (the model is told to wrap
 * up) and cancel the loop on the step past the turn cap.
 */
export function attachTurnLimits(
  agent: Agent,
  agentCtx: Context,
  limits: Pick<AgentLimits, "maxTurns" | "maxToolCalls">,
  onLimit: (hit: LimitHit) => void,
): void {
  let toolCalls = 0;
  let turns = 0;
  let deniedOnce = false;

  agentCtx.on("tools/pre-execute", async (_exec, next) => {
    toolCalls += 1;
    if (toolCalls > limits.maxToolCalls) {
      if (!deniedOnce) {
        deniedOnce = true;
        onLimit({ kind: "tool_calls", limit: limits.maxToolCalls });
      }
      return {
        kind: "deny" as const,
        reason: `Tool call limit reached (${limits.maxToolCalls}). Answer from what you have, and say what is missing.`,
      };
    }
    return next();
  });

  agentCtx.on("agent/pre-step", async (_payload, next) => {
    turns += 1;
    if (turns > limits.maxTurns) {
      onLimit({ kind: "turns", limit: limits.maxTurns });
      agent.cancel({ kind: "user" });
      return { kind: "reject" as const };
    }
    return next();
  });
}
