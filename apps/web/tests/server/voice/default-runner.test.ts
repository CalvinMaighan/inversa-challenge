import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetHarness } from "@/server/agent/cordis/boot";
import { setMockScript, type MockStepInput } from "@/server/agent/cordis/plugins/mock-llm";
import { agentViewFromHud, defaultAgentRunner } from "server/voice/agent-runner";
import { VoiceBudget } from "server/voice/budget";
import { VoiceSession } from "server/voice/voice-session";
import type { VoiceServerEvent } from "shared/voice/protocol";

import { setupAgentEnv, type AgentEnv } from "../agent/helpers";
import { startMockXai, toolOutputs, until } from "./mock-xai";

const HUD = {
  camera: { lat: 25.1417, lon: -80.9237, altitudeM: 15_000, place: "Flamingo" },
  bbox: { west: -81.02, south: 25.06, east: -80.83, north: 25.22 },
  time: { at: "2026-09-30T12:00:00.000Z", live: false, playing: false, speed: 8, from: "2026-08-31T12:00:00.000Z", to: "2026-09-30T12:00:00.000Z" },
  layers: ["sightings", "hotspots"],
  species: ["python"],
  selection: "sighting:inat-1",
  drawerOpen: false,
};

let env: AgentEnv;
const savedHarness = process.env.AGENT_HARNESS;

beforeAll(() => {
  env = setupAgentEnv();
  process.env.AGENT_HARNESS = "mock";
});

afterAll(async () => {
  if (savedHarness === undefined) delete process.env.AGENT_HARNESS;
  else process.env.AGENT_HARNESS = savedHarness;
  await resetHarness();
  env.cleanup();
});

describe("default agent runner", () => {
  test("HUD state maps to the agent view input", () => {
    expect(agentViewFromHud(HUD)).toEqual({
      bbox: HUD.bbox,
      time: "2026-09-30T12:00:00.000Z",
      layers: ["sightings", "hotspots"],
      selection: "sighting:inat-1",
    });
    expect(agentViewFromHud(null)).toBeUndefined();
    expect(agentViewFromHud({ bbox: { west: 1 }, time: { at: "2026-09-30T12:00:00Z" } })).toBeUndefined();
    expect(agentViewFromHud({ ...HUD, time: { at: "not a time" } })).toBeUndefined();
  });

  test("spawn_thinking runs cordis runTurn (mock harness) and streams its events", async () => {
    const question = "How fresh are the feeds around Flamingo?";
    const seen: MockStepInput[] = [];
    setMockScript(question, (input) => {
      seen.push(input);
      return { text: "Every feed is nominal." };
    });

    const mock = startMockXai();
    const session = new VoiceSession({
      ip: "127.0.0.1",
      target: { url: mock.url, apiKey: "test-key-not-real" },
      runner: defaultAgentRunner,
      budget: new VoiceBudget({ dataDir: mkdtempSync(path.join(tmpdir(), "voice-runner-")), dailyMinutes: 60 }),
      maxSessionMs: 60_000,
    });
    try {
      await session.connect();
      const events: VoiceServerEvent[] = [];
      session.subscribe((event) => events.push(event));
      session.setViewState(HUD);
      mock.send({ type: "response.created", response: { id: "r1" } });
      mock.send({
        type: "response.function_call_arguments.done",
        response_id: "r1",
        call_id: "c1",
        name: "spawn_thinking",
        arguments: JSON.stringify({ objective: question }),
      });
      mock.send({ type: "response.done", response: { id: "r1" } });

      await until(() => events.some((e) => e.type === "task.updated" && e.task.status !== "running"), 10_000);
      const settled = events.filter((e) => e.type === "task.updated").at(-1) as Extract<VoiceServerEvent, { type: "task.updated" }>;
      expect(settled.task.status).toBe("completed");
      expect(settled.task.summary).toContain("Every feed is nominal.");
      expect(toolOutputs(mock)[0]!.output.status).toBe("accepted");

      const streamed = events.filter((e) => e.type === "task.event").map((e) => (e as { event: { type: string } }).event.type);
      expect(streamed).toContain("content_delta");
      expect(streamed.at(-1)).toBe("done");

      // The HUD reached the agent as its view context.
      expect(seen.length).toBeGreaterThan(0);
      expect(JSON.stringify(seen[0])).toContain("2026-09-30T12:00:00.000Z");
    } finally {
      session.close("test");
      mock.stop();
    }
  });
});
