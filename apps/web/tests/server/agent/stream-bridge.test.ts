import { describe, expect, test } from "bun:test";

import type { Agent } from "@deepseek-ai/dsh-agent";

import { EvidenceLedger } from "@/server/agent/cordis/capability-tools";
import { attachStreamBridge } from "@/server/agent/cordis/stream-bridge";
import { isAgentStreamEvent, type AgentStreamEvent } from "@/shared/agent/events";

/**
 * The bridge maps harness session events to C7. These tests feed it a scripted
 * session-event sequence directly (no model, no loop) and check the C7 output.
 */

type Listener = (...args: unknown[]) => void;

function scriptedAgent() {
  const listeners = new Map<string, Listener[]>();
  const sessionEvents: { type: string; data: unknown }[] = [];
  const agent = {
    ctx: {
      on(name: string, listener: Listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
    },
    session: { events: sessionEvents },
  } as unknown as Agent;
  const session = {};
  return {
    agent,
    send(type: string, data: unknown = {}) {
      const event = { type, data };
      sessionEvents.push(event);
      for (const listener of listeners.get("session/event") ?? []) listener(session, event);
    },
    fail(error: unknown) {
      for (const listener of listeners.get("agent/error") ?? []) listener({ error });
    },
  };
}

const text = (value: string) => ({ type: "assistant/chunk", chunk: { type: "text-delta", index: 0, text: value } });

function run(script: (s: ReturnType<typeof scriptedAgent>, ledger: EvidenceLedger) => void, options?: { holdFinal?: boolean }) {
  const scripted = scriptedAgent();
  const ledger = new EvidenceLedger();
  const events: AgentStreamEvent[] = [];
  const bridge = attachStreamBridge(scripted.agent, ledger, (event) => events.push(event), options);
  script(scripted, ledger);
  return { bridge, events, of: <T extends AgentStreamEvent["type"]>(type: T) => events.filter((e) => e.type === type) as Extract<AgentStreamEvent, { type: T }>[] };
}

describe("stream bridge", () => {
  test("tool call, verified and invented citations, think tags and usage map to C7", () => {
    const { bridge, events, of } = run((s, ledger) => {
      s.send("turn/start");
      s.send("assistant/chunk", { chunk: { type: "reasoning-delta", index: 0, text: "need alerts" } });
      s.send("assistant/message", {
        message: { content: [{ type: "tool-call", id: "c1", name: "alerts", arguments: "{}" }] },
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 100 },
      });
      s.send("tool/call", { name: "alerts", callId: "c1", arguments: '{"bbox":{"west":-81.1,"south":24.85,"east":-80.35,"north":25.25}}' });
      // The capability adds its evidence to the ledger before the result lands.
      ledger.add([
        { id: "alert:5002", kind: "alert", label: "Small Craft Advisory" },
        { id: "fetch:77", kind: "fetch", label: "nwws fetch" },
      ]);
      s.send("tool/result", {
        message: { source: { callId: "c1" }, content: [{ isError: false, content: [{ type: "text", text: "{}" }] }] },
        meta: { capabilityName: "alerts", ok: true, data: { count: 1, evidence: [{ id: "alert:5002", kind: "alert", label: "x" }], feeds: [] } },
      });
      s.send("turn/start");
      for (const chunk of ["Small Craft Advisory [e:ale", "rt:5002] <thi", "nk>check den</think>and a den [e:sighting:424242] nearby [e:fetch:77]."]) {
        s.send(text(chunk).type, { chunk: text(chunk).chunk });
      }
      s.send("assistant/message", {
        message: {
          content: [
            {
              type: "text",
              text: "Small Craft Advisory [e:alert:5002] <think>check den</think>and a den [e:sighting:424242] nearby [e:fetch:77].",
            },
          ],
        },
        usage: { inputTokens: 1500, outputTokens: 30, cacheReadTokens: 0 },
      });
    });

    expect(events.every(isAgentStreamEvent)).toBe(true);
    const streamed = of("content_delta").map((event) => event.text).join("");
    expect(streamed).toBe("Small Craft Advisory [e:alert:5002] and a den nearby [e:fetch:77].");
    expect(bridge.finalText()).toBe("Small Craft Advisory [e:alert:5002] and a den nearby [e:fetch:77].");
    expect(of("citation").map((event) => [event.id, event.kind, event.label])).toEqual([
      ["alert:5002", "alert", "Small Craft Advisory"],
      ["fetch:77", "fetch", "nwws fetch"],
    ]);
    expect(bridge.citations()).toEqual(["alert:5002", "fetch:77"]);
    expect(of("debug").map((event) => event.text)).toEqual(["unverified citation removed: sighting:424242"]);
    expect(of("reasoning_delta").map((event) => event.text).join("|")).toBe("need alerts|check den");
    expect(of("tool_start")).toEqual([
      {
        type: "tool_start",
        toolCallId: "c1",
        capabilityName: "alerts",
        args: { bbox: { west: -81.1, south: 24.85, east: -80.35, north: 25.25 } },
      },
    ]);
    expect(of("tool_end")[0]).toMatchObject({ toolCallId: "c1", capabilityName: "alerts", ok: true, data: { count: 1 } });
    expect(of("status").map((event) => event.state)).toEqual(["thinking", "reading", "thinking", "generating"]);
    expect(bridge.usage).toEqual({ promptTokens: 2_400, completionTokens: 70, cacheRead: 100 });
    expect(bridge.toolCalls.map((call) => [call.capabilityName, call.ok])).toEqual([["alerts", true]]);
    expect(bridge.streamedContent).toBe(true);
    expect(bridge.finishError).toBeUndefined();
  });

  test("holdFinal streams a lead-in before a tool call at once, holds the final answer, and a discarded draft never reaches the client", () => {
    const { bridge, of } = run((s, ledger) => {
      ledger.add([{ id: "status:MCGL1", kind: "alert", label: "MCGL1" }]);
      s.send("turn/start");
      s.send("assistant/chunk", { chunk: text("Checking the sites.").chunk });
      s.send("assistant/message", { message: { content: [{ type: "text", text: "Checking the sites." }, { type: "tool-call", id: "c1", name: "site_status", arguments: "{}" }] } });
      s.send("assistant/chunk", { chunk: text("Draft [e:status:MCGL1] [e:status:BOGUS]").chunk });
      s.send("assistant/message", { message: { content: [{ type: "text", text: "Draft [e:status:MCGL1] [e:status:BOGUS]" }] } });
    }, { holdFinal: true });
    expect(of("content_delta").map((e) => e.text).join("")).toBe("Checking the sites.");
    expect(bridge.heldText()).toBe("Draft [e:status:MCGL1] [e:status:BOGUS]");
    expect(bridge.citations()).toEqual([]);
    expect(bridge.streamedContent).toBe(true);
    bridge.discardHeld();
    expect(bridge.heldText()).toBeUndefined();
    bridge.releaseHeld();
    expect(of("content_delta").map((e) => e.text).join("")).toBe("Checking the sites.");

    const released = run((s, ledger) => {
      ledger.add([{ id: "status:MCGL1", kind: "alert", label: "MCGL1" }]);
      s.send("assistant/chunk", { chunk: text("Final [e:status:MCGL1] [e:status:BOGUS].").chunk });
      s.send("assistant/message", { message: { content: [{ type: "text", text: "Final [e:status:MCGL1] [e:status:BOGUS]." }] } });
    }, { holdFinal: true });
    expect(released.of("content_delta")).toEqual([]);
    released.bridge.releaseHeld();
    expect(released.of("content_delta").map((e) => e.text).join("")).toBe("Final [e:status:MCGL1].");
    expect(released.of("citation").map((e) => e.id)).toEqual(["status:MCGL1"]);
    expect(released.bridge.heldText()).toBeUndefined();
    expect(released.bridge.finalText()).toBe("Final [e:status:MCGL1].");
  });

  test("a denied tool call becomes tool_end ok=false with the denial text", () => {
    const { of, bridge } = run((s) => {
      s.send("tool/call", { name: "feed_state", callId: "c9", arguments: "not json" });
      s.send("tool/result", {
        message: {
          source: { callId: "c9" },
          content: [{ isError: true, content: [{ type: "text", text: "Tool call limit reached (30). Answer from what you have." }] }],
        },
      });
    });
    expect(of("tool_start")[0]!.args).toBe("not json");
    expect(of("tool_end")[0]).toMatchObject({ capabilityName: "feed_state", ok: false, error: "Tool call limit reached (30). Answer from what you have." });
    expect(bridge.toolCalls[0]!.ok).toBe(false);
  });

  test("error and length finishes surface as error events and finishError", () => {
    const errored = run((s) => {
      s.send("assistant/chunk", { chunk: { type: "finish", reason: { kind: "error", failure: { message: "The model returned an empty reply." } } } });
    });
    expect(errored.of("error").map((event) => event.message)).toEqual(["The model returned an empty reply."]);
    expect(errored.bridge.finishError).toBe("The model returned an empty reply.");
    expect(errored.bridge.streamedContent).toBe(false);

    const truncated = run((s) => {
      s.send("assistant/chunk", { chunk: { type: "finish", reason: { kind: "max-tokens" } } });
    });
    expect(truncated.bridge.finishError).toContain("length limit");

    const thrown = run((s) => s.fail(new Error("OpenRouter: 401 Unauthorized")));
    expect(thrown.of("error").map((event) => event.message)).toEqual(["OpenRouter: 401 Unauthorized"]);
  });
});
