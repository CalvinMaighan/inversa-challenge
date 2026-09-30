import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_NOW, startStub, type Stub } from "@/eval/stub-server";
import { resetBudgetCache } from "@/server/agent/budget";
import { clearAnswerCache } from "@/server/agent/cache";
import { clearMockScripts } from "@/server/agent/cordis/plugins/mock-llm";
import { runTurn, type RunTurnParams, type RunTurnResult } from "@/server/agent/run-turn";
import { resetSessions } from "@/server/agent/session";
import type { AgentStreamEvent } from "@/shared/agent/events";

export const NOW = new Date(FIXTURE_NOW);

export type AgentEnv = { stub: Stub; dataDir: string; cleanup(): void };

/** Fixture GraphQL stub plus a throwaway data dir, wired through the env the harness reads. */
export function setupAgentEnv(): AgentEnv {
  const stub = startStub();
  const dataDir = mkdtempSync(join(tmpdir(), "inversa-agent-test-"));
  process.env.INVERSA_API_ORIGIN = stub.origin;
  process.env.INVERSA_DATA_DIR = dataDir;
  resetState();
  return {
    stub,
    dataDir,
    cleanup() {
      stub.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function resetState(): void {
  clearMockScripts();
  clearAnswerCache();
  resetBudgetCache();
  resetSessions();
  delete process.env.AGENT_DAILY_TOKENS;
}

let sessionSeq = 0;

/** One mock-harness turn; returns every streamed event. */
export async function turn(
  question: string,
  extra: Partial<RunTurnParams> = {},
): Promise<{ events: AgentStreamEvent[]; result: RunTurnResult }> {
  const events: AgentStreamEvent[] = [];
  sessionSeq += 1;
  const result = await runTurn(
    { sessionId: `test-${Date.now()}-${sessionSeq}`, question, harnessMode: "mock", now: NOW, cache: false, ...extra },
    (event) => events.push(event),
  );
  return { events, result };
}

export function ofType<T extends AgentStreamEvent["type"]>(
  events: AgentStreamEvent[],
  type: T,
): Extract<AgentStreamEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentStreamEvent, { type: T }> => event.type === type);
}

export function streamedText(events: AgentStreamEvent[]): string {
  return ofType(events, "content_delta")
    .map((event) => event.text)
    .join("");
}
