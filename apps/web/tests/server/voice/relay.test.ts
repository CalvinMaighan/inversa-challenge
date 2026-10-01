import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { get, init } from "@calvinjs/active-state";

import { state, VIEW } from "client/state";
import { emitTaskEvent } from "client/voice/task-events";
import { applyUiCommand } from "client/voice/ui-command-handler";
import { onTaskEvent } from "client/voice/voice-runtime";
import type { AgentStreamEvent } from "shared/agent/events";
import type { AgentRunEvent, AgentRunInput, AgentRunner } from "server/voice/agent-runner";
import { VoiceBudget } from "server/voice/budget";
import { getApp } from "shared/apps";
import { UI_TOOL_NAMES } from "shared/voice/ui-tools";
import { VoiceSession } from "server/voice/voice-session";
import type { VoiceServerEvent } from "shared/voice/protocol";

import { startMockXai, toolOutputs, until, type MockXai } from "./mock-xai";

type Harness = { mock: MockXai; session: VoiceSession; events: VoiceServerEvent[] };

const open: Harness[] = [];

function idleRunner(): AgentRunner {
  return { run: () => new Promise(() => undefined) };
}

async function startSession(runner: AgentRunner = idleRunner()): Promise<Harness> {
  const mock = startMockXai();
  const session = new VoiceSession({
    ip: "127.0.0.1",
    app: getApp("python"),
    target: { url: mock.url, apiKey: "test-key-not-real" },
    runner,
    budget: new VoiceBudget({ dataDir: mkdtempSync(path.join(tmpdir(), "voice-relay-")), dailyMinutes: 60 }),
    maxSessionMs: 60_000,
  });
  await session.connect();
  const events: VoiceServerEvent[] = [];
  session.subscribe((event) => events.push(event));
  const harness = { mock, session, events };
  open.push(harness);
  return harness;
}

/** One provider response that makes a single function call. */
function modelCalls(mock: MockXai, responseId: string, callId: string, name: string, args: unknown): void {
  mock.send({ type: "response.created", response: { id: responseId } });
  mock.send({
    type: "response.function_call_arguments.done",
    response_id: responseId,
    call_id: callId,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  });
  mock.send({ type: "response.done", response: { id: responseId } });
}

/** A result context was injected as a conversation item (the persona itself mentions the tag). */
function announced(mock: MockXai): boolean {
  return mock.received.some((e) => e.type === "conversation.item.create" && JSON.stringify(e.item).includes("<result_context>"));
}

beforeAll(() => init(state));

afterEach(() => {
  for (const { mock, session } of open.splice(0)) {
    session.close("test");
    mock.stop();
  }
});

describe("voice relay against a mocked xAI socket", () => {
  test("session.update carries the persona, eve, server VAD and all ten tools", async () => {
    const { mock } = await startSession();
    const update = await mock.waitFor((e) => e.type === "session.update");
    const session = update.session as {
      voice: string;
      instructions: string;
      turn_detection: { type: string };
      tools: { name: string; parameters: Record<string, unknown> }[];
      audio: { input: { format: { rate: number } }; output: { format: { rate: number } } };
    };
    expect(mock.authHeaders[0]).toBe("Bearer test-key-not-real");
    expect(session.voice).toBe("eve");
    expect(session.turn_detection.type).toBe("server_vad");
    expect(session.audio.input.format.rate).toBe(16_000);
    expect(session.audio.output.format.rate).toBe(24_000);
    expect(session.instructions).toContain(getApp("python").agent.persona);
    expect(session.instructions).toContain(getApp("python").agent.refusal);
    expect(session.instructions).toContain("Never invent numbers");
    expect(session.tools.map((t) => t.name).sort()).toEqual(
      [...UI_TOOL_NAMES, "spawn_thinking", "get_task_status", "cancel_task", "view_screen"].sort(),
    );
    const flyTo = session.tools.find((t) => t.name === "fly_to")!;
    expect(flyTo.parameters.type).toBe("object");
    expect(flyTo.parameters).not.toHaveProperty("$schema");
  });

  test("fly_to reaches VIEW", async () => {
    const { mock, events } = await startSession();
    modelCalls(mock, "resp_fly", "call_fly", "fly_to", { place: "Flamingo" });

    await until(() => events.some((e) => e.type === "ui.command"));
    const command = events.find((e) => e.type === "ui.command") as Extract<VoiceServerEvent, { type: "ui.command" }>;
    expect(command.name).toBe("fly_to");
    expect(command.args).toMatchObject({ place: "Flamingo", lat: 25.1417, lon: -80.9237 });

    // Browser side: the events stream hands the command to the handler, which moves the camera.
    const before = get<typeof VIEW.defaults>(VIEW)!.seq;
    expect(applyUiCommand(command)).toBe(true);
    expect(get<typeof VIEW.defaults>(VIEW)).toMatchObject({ lat: 25.1417, lon: -80.9237, place: "Flamingo", seq: before + 1 });

    // Model side: an ok receipt for the call, then exactly one follow-up response.
    await mock.waitFor((e) => e.type === "response.create");
    expect(toolOutputs(mock)).toEqual([{ callId: "call_fly", output: { ok: true } }]);
    expect(mock.received.filter((e) => e.type === "response.create")).toHaveLength(1);
    const order = mock.received.map((e) => e.type);
    expect(order.lastIndexOf("conversation.item.create")).toBeLessThan(order.lastIndexOf("response.create"));
    expect(events.filter((e) => e.type === "tool.call").map((e) => (e as { status: string }).status)).toEqual([
      "started",
      "done",
    ]);
  });

  test("rejects invalid ui tool", async () => {
    const { mock, events } = await startSession();
    modelCalls(mock, "resp_1", "call_bad_lat", "fly_to", { lat: 200, lon: -80 });
    modelCalls(mock, "resp_2", "call_bad_layer", "toggle_layer", { layer: "radar", visible: true });
    modelCalls(mock, "resp_3", "call_bad_place", "fly_to", { place: "Atlantis" });
    modelCalls(mock, "resp_4", "call_bad_time", "set_time", { time: "last tuesday" });
    modelCalls(mock, "resp_5", "call_bad_json", "select", "{not json");

    await until(() => toolOutputs(mock).length === 5);
    const outputs = new Map(toolOutputs(mock).map((o) => [o.callId, o.output]));
    for (const id of ["call_bad_lat", "call_bad_layer", "call_bad_place", "call_bad_time", "call_bad_json"]) {
      expect(outputs.get(id)?.ok).toBe(false);
      expect(typeof outputs.get(id)?.error).toBe("string");
    }
    expect(String(outputs.get("call_bad_place")?.error)).toContain("lat and lon");
    expect(String(outputs.get("call_bad_lat")?.error)).toContain("fly_to");
    // Nothing reached the browser.
    expect(events.some((e) => e.type === "ui.command")).toBe(false);
  });

  test("several calls in one response get one follow-up after all outputs", async () => {
    const { mock, events } = await startSession();
    mock.send({ type: "response.created", response: { id: "resp_multi" } });
    mock.send({
      type: "response.function_call_arguments.done",
      response_id: "resp_multi",
      call_id: "c1",
      name: "toggle_layer",
      arguments: JSON.stringify({ layer: "hotspots", visible: true, species: "python" }),
    });
    mock.send({
      type: "response.function_call_arguments.done",
      response_id: "resp_multi",
      call_id: "c2",
      name: "set_time",
      arguments: JSON.stringify({ time: "now" }),
    });
    mock.send({ type: "response.done", response: { id: "resp_multi" } });
    await mock.waitFor((e) => e.type === "response.create");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toolOutputs(mock).map((o) => o.callId)).toEqual(["c1", "c2"]);
    expect(mock.received.filter((e) => e.type === "response.create")).toHaveLength(1);
    expect(events.filter((e) => e.type === "ui.command").map((e) => (e as { name: string }).name)).toEqual([
      "toggle_layer",
      "set_time",
    ]);
  });

  test("view_screen returns the HUD state the client posted", async () => {
    const { mock, session } = await startSession();
    modelCalls(mock, "resp_v0", "call_v0", "view_screen", {});
    await until(() => toolOutputs(mock).length === 1);
    expect(toolOutputs(mock)[0]!.output).toMatchObject({ ok: true, screen: null });

    const hud = { camera: { lat: 25.14, lon: -80.92, altitudeM: 15_000, place: "Flamingo" }, layers: ["hotspots"], selection: null };
    session.setViewState(hud);
    modelCalls(mock, "resp_v1", "call_v1", "view_screen", {});
    await until(() => toolOutputs(mock).length === 2);
    expect(toolOutputs(mock)[1]!.output).toMatchObject({ ok: true, screen: hud });
  });

  test("spawn_thinking runs the injected runner with the view and speaks the result", async () => {
    const calls: AgentRunInput[] = [];
    let finish: (content: string) => void = () => undefined;
    let emit: (event: AgentRunEvent) => void = () => undefined;
    const runner: AgentRunner = {
      run(input, onEvent) {
        calls.push(input);
        emit = onEvent;
        return new Promise((resolve) => {
          finish = (content) => resolve({ content, citations: ["sighting:1"] });
        });
      },
    };
    const { mock, session, events } = await startSession(runner);
    session.setViewState({ camera: { place: "Flamingo" } });
    modelCalls(mock, "resp_s", "call_s", "spawn_thinking", { objective: "How many python sightings near Flamingo this week?" });

    await until(() => toolOutputs(mock).length === 1);
    const receipt = toolOutputs(mock)[0]!.output;
    expect(receipt.status).toBe("accepted");
    const taskId = String(receipt.task_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: session.id,
      app: "python",
      question: "How many python sightings near Flamingo this week?",
      view: { camera: { place: "Flamingo" } },
    });
    expect(calls[0]!.signal?.aborted).toBe(false);

    emit({ type: "tool_start", toolCallId: "t1", capabilityName: "sightings" });
    const running = events.filter((e) => e.type === "task.updated").at(-1) as Extract<VoiceServerEvent, { type: "task.updated" }>;
    expect(running.task).toMatchObject({ id: taskId, status: "running", step: "sightings" });

    // The same question again is a duplicate of the running task, not a second run.
    modelCalls(mock, "resp_d", "call_d", "spawn_thinking", { objective: "how many python sightings near  flamingo this week?" });
    await until(() => toolOutputs(mock).length === 2);
    expect(toolOutputs(mock)[1]!.output).toEqual({ status: "duplicate", task_id: taskId });
    expect(calls).toHaveLength(1);

    finish("Twelve python sightings within 10 km of Flamingo since Monday [e:sighting:1].");
    await until(() => events.some((e) => e.type === "task.updated" && e.task.status === "completed"));

    // Announcement window is clear (no user speech, no audio), so the result is injected at once.
    const injected = await mock.waitFor(
      (e) =>
        e.type === "conversation.item.create" &&
        JSON.stringify(e.item).includes("<result_context>"),
    );
    expect(JSON.stringify(injected.item)).toContain("Twelve python sightings");
    const speak = await mock.waitFor(
      (e) => e.type === "response.create" && (e.response as { tool_choice?: string } | undefined)?.tool_choice === "none",
    );
    expect((speak.response as { instructions: string }).instructions).toContain("final result");

    modelCalls(mock, "resp_st", "call_st", "get_task_status", { task_id: taskId });
    await until(() => toolOutputs(mock).length === 3);
    expect(toolOutputs(mock)[2]!.output).toMatchObject({
      status: "ok",
      task: { task_id: taskId, status: "completed", summary: expect.stringContaining("Twelve") },
    });
  });

  test("task events stream to client", async () => {
    let emit: (event: AgentRunEvent) => void = () => undefined;
    let finish: () => void = () => undefined;
    const runner: AgentRunner = {
      run(_input, onEvent) {
        emit = onEvent;
        return new Promise((resolve) => (finish = () => resolve({ content: "Three alerts.", citations: ["alert:1"] })));
      },
    };
    const { mock, session, events } = await startSession(runner);

    // Browser side: the orb card subscribes; the runtime hands each `task.event` from the stream to the bus.
    const seen: { taskId: string; event: AgentStreamEvent }[] = [];
    const off = onTaskEvent((taskId, event) => seen.push({ taskId, event }));
    const unsubscribe = session.subscribe((e) => {
      if (e.type === "task.event") emitTaskEvent(e.taskId, e.event);
    });

    modelCalls(mock, "resp_te", "call_te", "spawn_thinking", { objective: "Any NWS alerts over Florida Bay?" });
    await until(() => toolOutputs(mock).length === 1);
    const taskId = String(toolOutputs(mock)[0]!.output.task_id);

    const stream: AgentStreamEvent[] = [
      { type: "status", state: "thinking" },
      { type: "tool_start", toolCallId: "t1", capabilityName: "alerts", args: { area: "Florida Bay" } },
      { type: "tool_end", toolCallId: "t1", capabilityName: "alerts", ok: true, data: { ids: ["alert:1"] } },
      { type: "content_delta", text: "Three " },
      { type: "content_delta", text: "alerts." },
      { type: "citation", id: "alert:1", kind: "alert", label: "Small Craft Advisory" },
      { type: "view", bbox: { west: -81.2, south: 24.8, east: -80.4, north: 25.3 }, time: "2026-09-30T12:00:00Z" },
      { type: "done", content: "Three alerts." },
    ];
    for (const event of stream) emit(event);
    emit({ type: "not_an_agent_event", junk: true });
    finish();
    await until(() => events.some((e) => e.type === "task.updated" && e.task.status === "completed"));
    emit({ type: "content_delta", text: "late" });
    await until(() => seen.length >= stream.length);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual(stream.map((event) => ({ taskId, event })));
    // Spoken progress still comes from the same stream.
    expect(events.some((e) => e.type === "task.updated" && e.task.step === "alerts")).toBe(true);

    off();
    unsubscribe();
    emitTaskEvent(taskId, { type: "content_delta", text: "after off" });
    expect(seen).toHaveLength(stream.length);
  });

  test("cancel_task aborts the runner and nothing is announced", async () => {
    let signal: AbortSignal | undefined;
    const runner: AgentRunner = {
      run(input) {
        signal = input.signal;
        return new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };
    const { mock, events } = await startSession(runner);
    modelCalls(mock, "resp_a", "call_a", "spawn_thinking", { objective: "Rank python hotspots in Homestead" });
    await until(() => toolOutputs(mock).length === 1);
    const taskId = String(toolOutputs(mock)[0]!.output.task_id);

    modelCalls(mock, "resp_c", "call_c", "cancel_task", {});
    await until(() => toolOutputs(mock).length === 2);
    expect(toolOutputs(mock)[1]!.output).toEqual({ status: "cancelled", task_id: taskId });
    expect(signal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const updates = events.filter((e) => e.type === "task.updated").map((e) => (e as { task: { status: string } }).task.status);
    expect(updates.at(-1)).toBe("canceled");
    expect(updates).not.toContain("failed");
    expect(announced(mock)).toBe(false);

    modelCalls(mock, "resp_c2", "call_c2", "cancel_task", { task_id: taskId });
    await until(() => toolOutputs(mock).length === 3);
    expect(toolOutputs(mock)[2]!.output).toEqual({ status: "not_active", task_id: taskId, current: "canceled" });
  });

  test("a failing runner reports failure through the announcement", async () => {
    const runner: AgentRunner = { run: async () => Promise.reject(new Error("GraphQL upstream down")) };
    const { mock, events } = await startSession(runner);
    modelCalls(mock, "resp_f", "call_f", "spawn_thinking", { objective: "Any NWS alerts for the Keys?" });
    await until(() => events.some((e) => e.type === "task.updated" && e.task.status === "failed"));
    const injected = await mock.waitFor(
      (e) => e.type === "conversation.item.create" && JSON.stringify(e.item).includes("<result_context>"),
    );
    expect(JSON.stringify(injected.item)).toContain("GraphQL upstream down");
  });

  test("announcement waits while the user is speaking", async () => {
    let finish: () => void = () => undefined;
    const runner: AgentRunner = {
      run: () => new Promise((resolve) => (finish = () => resolve({ content: "Done.", citations: [] }))),
    };
    const { mock, events } = await startSession(runner);
    modelCalls(mock, "resp_w", "call_w", "spawn_thinking", { objective: "Feed freshness?" });
    await until(() => toolOutputs(mock).length === 1);
    // Grok's follow-up to the tool receipt ("On it."), then the user starts talking again.
    await mock.waitFor((e) => e.type === "response.create");
    mock.send({ type: "response.created", response: { id: "resp_w_follow" } });
    mock.send({ type: "response.done", response: { id: "resp_w_follow" } });
    mock.send({ type: "input_audio_buffer.speech_started" });
    await until(() => events.some((e) => e.type === "playback.clear"));
    finish();
    await until(() => events.some((e) => e.type === "task.updated" && e.task.status === "completed"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(announced(mock)).toBe(false);

    // The user stops and their turn gets its (silent) reply: the window clears and the retry delivers.
    mock.send({ type: "input_audio_buffer.speech_stopped" });
    mock.send({ type: "input_audio_buffer.committed" });
    mock.send({ type: "response.created", response: { id: "resp_turn" } });
    mock.send({ type: "response.done", response: { id: "resp_turn" } });
    await until(() => announced(mock), 3_000);
  });

  test("a spoken stop cancels running analysis; a hang-up closes the session", async () => {
    let signal: AbortSignal | undefined;
    const runner: AgentRunner = {
      run(input) {
        signal = input.signal;
        return new Promise(() => undefined);
      },
    };
    const { mock, session, events } = await startSession(runner);
    modelCalls(mock, "resp_x", "call_x", "spawn_thinking", { objective: "Explain cell 10:20" });
    await until(() => toolOutputs(mock).length === 1);
    mock.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "Stop." });
    await until(() => signal?.aborted === true);
    expect(session.isClosed).toBe(false);
    await mock.waitFor((e) => e.type === "response.cancel");

    mock.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "hang up" });
    await until(() => session.isClosed);
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "user" });
  });

  test("audio and provider errors are relayed", async () => {
    const { mock, events } = await startSession();
    mock.send({ type: "response.created", response: { id: "resp_audio" } });
    mock.send({ type: "response.output_audio.delta", response_id: "resp_audio", delta: "AAAA" });
    mock.send({ type: "response.output_audio_transcript.delta", response_id: "resp_audio", delta: "Flying" });
    mock.send({ type: "response.done", response: { id: "resp_audio" } });
    mock.send({ type: "error", error: { message: "rate limited" } });
    await until(() => events.some((e) => e.type === "error"));
    expect(events).toContainEqual({ type: "audio.delta", responseId: "resp_audio", audio: "AAAA", sampleRate: 24_000 });
    expect(events).toContainEqual({ type: "audio.done", responseId: "resp_audio" });
    expect(events).toContainEqual({
      type: "transcript.assistant",
      responseId: "resp_audio",
      text: "Flying",
      final: false,
      origin: "turn",
    });
    expect(events).toContainEqual({ type: "error", message: "rate limited", fatal: false });
  });

  test("a rejected session.update fails the connect", async () => {
    const mock = startMockXai({ rejectSession: "invalid_api_key" });
    const session = new VoiceSession({
      ip: "127.0.0.1",
      app: getApp("python"),
      target: { url: mock.url, apiKey: "bad" },
      runner: idleRunner(),
      budget: new VoiceBudget({ dataDir: mkdtempSync(path.join(tmpdir(), "voice-relay-")), dailyMinutes: 60 }),
      maxSessionMs: 60_000,
    });
    await expect(session.connect()).rejects.toThrow("invalid_api_key");
    session.close("test");
    mock.stop();
  });
});
