import { describe, expect, test } from "bun:test";

import { createAudioUplink, mergePcm16Base64 } from "client/voice/audio-uplink";
import { BARGE_IN_SUSTAIN_MS, createBargeInDetector } from "client/voice/barge-in";
import { pcm16Base64 } from "client/voice/pcm";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("audio uplink", () => {
  test("one send in flight, later batches merge in order", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const uplink = createAudioUplink(async (audio) => {
      sent.push(audio);
      if (sent.length === 1) await gate;
    });
    const first = pcm16Base64(Float32Array.from([0.25]));
    const second = pcm16Base64(Float32Array.from([0.5]));
    const third = pcm16Base64(Float32Array.from([-0.5]));
    uplink.push(first);
    uplink.push(second);
    uplink.push(third);
    expect(sent).toEqual([first]);
    release();
    await gate;
    await tick();
    expect(sent).toEqual([first, mergePcm16Base64([second, third])]);
  });

  test("stop drops audio that has not been sent", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const uplink = createAudioUplink(async (audio) => {
      sent.push(audio);
      await gate;
    });
    const first = pcm16Base64(Float32Array.from([0.25]));
    uplink.push(first);
    uplink.push(pcm16Base64(Float32Array.from([0.5])));
    uplink.stop();
    release();
    await gate;
    await tick();
    expect(sent).toEqual([first]);
  });

  test("hold queues until open, then sends in order", async () => {
    const sent: string[] = [];
    const uplink = createAudioUplink(
      async (audio) => {
        sent.push(audio);
      },
      { hold: true },
    );
    const first = pcm16Base64(Float32Array.from([0.25]));
    const second = pcm16Base64(Float32Array.from([0.5]));
    uplink.push(first);
    uplink.push(second);
    expect(sent).toEqual([]);
    uplink.open();
    await tick();
    expect(sent).toEqual([mergePcm16Base64([first, second])]);
  });
});

describe("barge-in", () => {
  test("stays quiet under the level and while idle, fires once after the sustain", () => {
    const quiet = createBargeInDetector();
    expect(quiet.push({ level: 0.01, playing: true, now: 0 })).toBe(false);
    expect(quiet.push({ level: 0.01, playing: true, now: 1_000 })).toBe(false);

    const idle = createBargeInDetector();
    expect(idle.push({ level: 1, playing: false, now: 0 })).toBe(false);
    expect(idle.push({ level: 1, playing: false, now: 1_000 })).toBe(false);

    const live = createBargeInDetector();
    expect(live.push({ level: 0.5, playing: true, now: 0 })).toBe(false);
    expect(live.push({ level: 0.5, playing: true, now: BARGE_IN_SUSTAIN_MS - 1 })).toBe(false);
    expect(live.push({ level: 0.5, playing: true, now: BARGE_IN_SUSTAIN_MS })).toBe(true);
    expect(live.push({ level: 0.5, playing: true, now: BARGE_IN_SUSTAIN_MS + 50 })).toBe(false);
    expect(live.push({ level: 0, playing: true, now: 2_000 })).toBe(false);
    expect(live.push({ level: 0.5, playing: true, now: 2_000 })).toBe(false);
    expect(live.push({ level: 0.5, playing: true, now: 2_000 + BARGE_IN_SUSTAIN_MS })).toBe(true);
  });
});
