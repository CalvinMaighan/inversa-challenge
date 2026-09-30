/**
 * What `spawn_thinking` runs. Typed here, not imported from the agent leaf, so voice builds
 * and tests without it; the default implementation resolves `server/agent/run-turn.ts` at
 * call time.
 */

export type AgentRunInput = {
  sessionId: string;
  question: string;
  /** Latest HUD state the browser posted (`view_state` control), or null. */
  view: unknown;
  /** Aborted when the task is cancelled or the voice session closes. */
  signal?: AbortSignal;
};

/**
 * Agent stream events (C7). The session relays every valid one to the browser as
 * `task.event` (content deltas, tools, citations, view, done) and reads `status` / `tool_start`
 * for spoken progress. The default runner passes `onEvent` straight through to `runTurn`.
 */
export type AgentRunEvent = { type: string } & Record<string, unknown>;

export type AgentRunResult = { content: string; citations: unknown[] };

export interface AgentRunner {
  run(input: AgentRunInput, onEvent: (event: AgentRunEvent) => void): Promise<AgentRunResult>;
}

/** Path under `server/` of the agent leaf's turn runner. */
const RUN_TURN_MODULE = "agent/run-turn";

function normalizeResult(value: unknown): AgentRunResult {
  if (typeof value === "string") return { content: value, citations: [] };
  if (value && typeof value === "object") {
    const { content, citations } = value as { content?: unknown; citations?: unknown };
    return {
      content: typeof content === "string" ? content : "",
      citations: Array.isArray(citations) ? citations : [],
    };
  }
  return { content: "", citations: [] };
}

type RunTurn = (input: AgentRunInput, onEvent: (event: AgentRunEvent) => void) => Promise<unknown>;

let cached: Promise<RunTurn> | null = null;

/**
 * `modulePath` is a parameter under `server/`, so neither tsc nor Turbopack pins one file that
 * may not exist yet: Turbopack bundles a `server/**` context and the lookup happens at call
 * time. Voice builds before the agent leaf lands and picks `server/agent/run-turn` up once it does.
 */
async function loadServerModule(modulePath: string): Promise<{ runTurn?: unknown }> {
  return (await import(`../${modulePath}`)) as { runTurn?: unknown };
}

async function loadRunTurn(): Promise<RunTurn> {
  let mod: { runTurn?: unknown };
  try {
    mod = await loadServerModule(RUN_TURN_MODULE);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Analysis is unavailable: server/agent/run-turn could not be loaded (${reason})`);
  }
  if (typeof mod.runTurn !== "function") {
    throw new Error("Analysis is unavailable: server/agent/run-turn does not export runTurn");
  }
  return mod.runTurn as RunTurn;
}

export const defaultAgentRunner: AgentRunner = {
  async run(input, onEvent) {
    cached ??= loadRunTurn().catch((error: unknown) => {
      cached = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
    const runTurn = await cached;
    return normalizeResult(await runTurn(input, onEvent));
  },
};
