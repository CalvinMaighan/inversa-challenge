import type { AgentStreamEvent, AgentStreamRequest, BBox } from "shared/agent/events";
import { getApp, speciesIds, type AppId } from "shared/apps";

/**
 * What `spawn_thinking` runs. The session depends on this interface only, so tests inject a fake;
 * the default implementation is the cordis agent's `runTurn` (server/agent/run-turn.ts).
 */

export type AgentRunInput = {
  sessionId: string;
  /** The voice session's app; the analyst answers within it. */
  app: AppId;
  question: string;
  /** Latest HUD state the browser posted (`view_state` control), or null. */
  view: unknown;
  /** Aborted when the task is cancelled or the voice session closes. */
  signal?: AbortSignal;
};

/**
 * Agent stream events (C7). The session relays every valid one to the browser as `task.event`
 * (content deltas, tools, citations, view, done) and reads `status` / `tool_start` for spoken
 * progress.
 */
export type AgentRunEvent = { type: string } & Record<string, unknown>;

export type AgentRunResult = { content: string; citations: unknown[] };

export interface AgentRunner {
  run(input: AgentRunInput, onEvent: (event: AgentRunEvent) => void): Promise<AgentRunResult>;
}

type AgentView = NonNullable<AgentStreamRequest["view"]>;

function isBBox(value: unknown): value is BBox {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return ["west", "south", "east", "north"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k]));
}

/**
 * The HUD snapshot (`client/voice/hud-state.ts` HudState) reduced to the agent's view input.
 * Undefined when the browser has not posted one or it is malformed: the agent then uses no view.
 */
export function agentViewFromHud(hud: unknown, app: AppId): AgentView | undefined {
  if (!hud || typeof hud !== "object") return undefined;
  const { bbox, time, layers, species, selection } = hud as Record<string, unknown>;
  const at = typeof time === "string" ? time : (time as { at?: unknown } | null)?.at;
  if (!isBBox(bbox) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return undefined;
  // The species filter, like the typed chat sends it: only when it hides some species.
  const keys = speciesIds(getApp(app));
  const shown = Array.isArray(species) ? keys.filter((k) => species.includes(k)) : null;
  return {
    bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north },
    time: at,
    layers: Array.isArray(layers) ? layers.filter((l): l is string => typeof l === "string") : [],
    ...(shown && keys.some((k) => !shown.includes(k)) ? { species: shown } : {}),
    selection: typeof selection === "string" ? selection : null,
  };
}

/** Cordis `runTurn`, loaded on first use so opening a voice session does not boot the agent harness. */
export const defaultAgentRunner: AgentRunner = {
  async run(input, onEvent) {
    const { runTurn } = await import("@/server/agent/run-turn");
    // runTurn never throws: failures come back as content plus an `error` event.
    const result = await runTurn(
      {
        sessionId: `voice-${input.sessionId}`,
        app: input.app,
        question: input.question,
        view: agentViewFromHud(input.view, input.app),
        signal: input.signal,
      },
      (event: AgentStreamEvent) => onEvent(event),
    );
    return { content: result.content, citations: result.citations };
  },
};
