import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { init } from "@calvinjs/active-state";

import { state } from "client/state";
import type { Route } from "server/agent/decisions";
import type { AgentRunInput, AgentRunner } from "server/voice/agent-runner";
import { VoiceBudget } from "server/voice/budget";
import { VoiceSession } from "server/voice/voice-session";
import { getApp } from "shared/apps";

import { startMockXai, until, type MockXai } from "./mock-xai";

/** The analyst starts when a sentence ends in the streaming transcript, not when the provider's end of turn and the final transcript come in. */

const route: Route = { intent: "reports", intentConfidence: 0.97, onTopic: 0.97, suggestedTools: ["sightings"], latencyMs: 5 };
const open: { mock: MockXai; session: VoiceSession }[] = [];

function startSession(): Promise<{ mock: MockXai; session: VoiceSession; asked: AgentRunInput[]; aborted: boolean[] }> {
  const asked: AgentRunInput[] = [];
  const aborted: boolean[] = [];
  const runner: AgentRunner = {
    run: (input) => {
      asked.push(input);
      const index = aborted.push(false) - 1;
      input.signal?.addEventListener("abort", () => (aborted[index] = true));
      return new Promise(() => undefined);
    },
  };
  const mock = startMockXai();
  const session = new VoiceSession({
    ip: "127.0.0.1",
    app: getApp("lionfish"),
    target: { url: mock.url, apiKey: "test-key-not-real" },
    runner,
    budget: new VoiceBudget({ dataDir: mkdtempSync(path.join(tmpdir(), "voice-early-")), dailyMinutes: 60 }),
    maxSessionMs: 60_000,
    greet: false,
    route: async () => route,
  });
  return session.connect().then(() => {
    open.push({ mock, session });
    return { mock, session, asked, aborted };
  });
}

const delta = (mock: MockXai, text: string) => mock.send({ type: "conversation.item.input_audio_transcription.delta", text });
const completed = (mock: MockXai, transcript: string) => mock.send({ type: "conversation.item.input_audio_transcription.completed", transcript });

beforeAll(() => init(state));
afterEach(() => {
  for (const { mock, session } of open.splice(0)) {
    session.close("test");
    mock.stop();
  }
});

describe("early analyst", () => {
  test("the end of a sentence in the streaming transcript starts the analyst before the provider ends the turn", async () => {
    const { mock, asked } = await startSession();
    mock.send({ type: "input_audio_buffer.speech_started" });
    delta(mock, "Where were lionfish");
    await new Promise((r) => setTimeout(r, 400));
    expect(asked).toHaveLength(0);
    delta(mock, "Where were lionfish reported this week?");
    await until(() => asked.length === 1);
    expect(asked[0]!.question).toBe("Where were lionfish reported this week?");
    expect(asked[0]!.app).toBe("lionfish");
  });

  test("the final transcript of the same sentence does not ask again", async () => {
    const { mock, asked } = await startSession();
    mock.send({ type: "input_audio_buffer.speech_started" });
    delta(mock, "How many reports are there in Belize?");
    await until(() => asked.length === 1);
    mock.send({ type: "input_audio_buffer.speech_stopped" });
    completed(mock, "How many reports are there in Belize?");
    await new Promise((r) => setTimeout(r, 500));
    expect(asked).toHaveLength(1);
  });

  test("when the user kept talking, the early analyst is stopped and the whole question is asked", async () => {
    const { mock, asked, aborted } = await startSession();
    mock.send({ type: "input_audio_buffer.speech_started" });
    delta(mock, "Where were lionfish seen last week?");
    await until(() => asked.length === 1);
    delta(mock, "Where were lionfish seen last week? And which area ranks highest for survey priority?");
    mock.send({ type: "input_audio_buffer.speech_stopped" });
    completed(mock, "Where were lionfish seen last week? And which area ranks highest for survey priority?");
    await until(() => asked.length === 2);
    expect(aborted[0]).toBe(true);
    expect(asked[1]!.question).toContain("ranks highest");
  });

  test("a half-said sentence or one without an ending mark does not start anything", async () => {
    const { mock, asked } = await startSession();
    mock.send({ type: "input_audio_buffer.speech_started" });
    delta(mock, "Where were lionfish");
    delta(mock, "Where were lionfish reported");
    await new Promise((r) => setTimeout(r, 450));
    expect(asked).toHaveLength(0);
  });
});
