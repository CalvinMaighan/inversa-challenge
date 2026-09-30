import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NOW, setupAgentEnv, type AgentEnv } from "../../server/agent/helpers";

import { resetHarness } from "@/server/agent/cordis/boot";
import { openRouterApiKey } from "@/server/agent/runtime/model";
import { defaultAgentRunner, type AgentRunEvent } from "server/voice/agent-runner";

/** Live: voice `spawn_thinking` runs the real agent through defaultAgentRunner, with the HUD as its view. */

let env: AgentEnv;

beforeAll(() => {
  if (!openRouterApiKey()) throw new Error("live tests need OPENROUTER_API_KEY: run `bun run test:live` (doppler inversa/dev)");
  env = setupAgentEnv();
});

afterAll(async () => {
  await resetHarness();
  env?.cleanup();
});

describe("voice default agent runner (live)", () => {
  test("runs a real turn, streams C7 events, and the HUD time is the agent's reference time", async () => {
    const hud = {
      camera: { lat: 25.05, lon: -80.7, altitudeM: 40_000, place: "Florida Bay" },
      bbox: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 },
      time: { at: NOW.toISOString(), live: false, playing: false, speed: 1 },
      layers: ["sightings"],
      selection: null,
    };
    const events: AgentRunEvent[] = [];
    const result = await defaultAgentRunner.run(
      { sessionId: `live-voice-${Date.now()}`, question: "Any NWS alerts in effect for Florida Bay right now?", view: hud },
      (event) => events.push(event),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("content_delta");
    expect(types.at(-1)).toBe("done");
    expect(types).not.toContain("error");
    expect(result.content).toMatch(/\[e:alert:\d+\]/);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    // The alerts tool asked for "now" at the HUD's timeline time, not the wall clock.
    const alerts = env.stub.requests.find((request) => request.operationName === "AgentAlerts");
    expect(alerts).toBeDefined();
    expect(Date.parse(String(alerts!.variables.at))).toBe(NOW.getTime());
  });
});
