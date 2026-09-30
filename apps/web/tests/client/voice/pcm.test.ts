import { describe, expect, test } from "bun:test";

import {
  concatFloat32,
  createStreamingResampler,
  decodePcm16Base64,
  pcm16Base64,
  rmsLevel,
  type Samples,
} from "client/voice/pcm";
import { VOICE_AUDIO_BATCH_MS, VOICE_INPUT_SAMPLE_RATE } from "shared/voice/protocol";

const TONE_HZ = 440;

function tone(rate: number, start: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => 0.8 * Math.sin((2 * Math.PI * TONE_HZ * (start + i)) / rate));
}

/** Feed `seconds` of a 440 Hz tone at `from` in uneven blocks, the way AudioWorklet and ScriptProcessor deliver it. */
function resampleStream(from: number, seconds: number, blocks: number[]): { chunks: Samples[]; total: number } {
  const r = createStreamingResampler();
  const inputLength = Math.round(from * seconds);
  const chunks: Samples[] = [];
  let offset = 0;
  let i = 0;
  while (offset < inputLength) {
    const size = Math.min(blocks[i % blocks.length]!, inputLength - offset);
    chunks.push(r.process(tone(from, offset, size), from, VOICE_INPUT_SAMPLE_RATE));
    offset += size;
    i += 1;
  }
  chunks.push(r.flush());
  return { chunks, total: chunks.reduce((sum, c) => sum + c.length, 0) };
}

describe("pcm resample", () => {
  test("resample 48 kHz to 16 kHz: one second gives 16000 samples, phase-continuous across 200 ms batches", () => {
    // 128 is the AudioWorklet render quantum; the odd sizes force batch edges at every phase.
    const { chunks, total } = resampleStream(48_000, 1, [128, 128, 100, 333, 2048, 7]);
    expect(total).toBe(16_000);

    const out = concatFloat32(chunks);
    // 48k → 16k is an exact 3:1 ratio, so every output sample lands on an input sample:
    // the stream must equal the tone sampled directly at 16 kHz, with no seam at any block edge.
    for (let n = 0; n < out.length; n += 1) {
      const ideal = 0.8 * Math.sin((2 * Math.PI * TONE_HZ * n) / VOICE_INPUT_SAMPLE_RATE);
      expect(Math.abs(out[n]! - ideal)).toBeLessThan(1e-5);
    }

    // Cut into the 200 ms batches mic-capture posts: 3200 samples each, and each batch
    // starts exactly where the previous one ended (no dropped or repeated sample).
    const batchSamples = (VOICE_INPUT_SAMPLE_RATE * VOICE_AUDIO_BATCH_MS) / 1000;
    expect(batchSamples).toBe(3200);
    for (let b = batchSamples; b < out.length; b += batchSamples) {
      const expectedStep =
        0.8 * Math.sin((2 * Math.PI * TONE_HZ * b) / VOICE_INPUT_SAMPLE_RATE) -
        0.8 * Math.sin((2 * Math.PI * TONE_HZ * (b - 1)) / VOICE_INPUT_SAMPLE_RATE);
      expect(Math.abs(out[b]! - out[b - 1]! - expectedStep)).toBeLessThan(1e-5);
    }
  });

  test("resample 44.1 kHz to 16 kHz keeps length and tracks the tone within interpolation error", () => {
    const { chunks, total } = resampleStream(44_100, 1, [128, 441, 1000]);
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
    const out = concatFloat32(chunks);
    const ratio = 44_100 / 16_000;
    let worst = 0;
    for (let n = 0; n < out.length - 1; n += 1) {
      const ideal = 0.8 * Math.sin((2 * Math.PI * TONE_HZ * n * ratio) / 44_100);
      worst = Math.max(worst, Math.abs(out[n]! - ideal));
    }
    // Linear interpolation of a 440 Hz tone at 44.1 kHz: error bound (ωΔt)²/8 × 0.8 ≈ 3e-4.
    expect(worst).toBeLessThan(1e-3);
  });

  test("resample passes a matching rate through untouched", () => {
    const r = createStreamingResampler();
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    expect(r.process(input, 16_000, 16_000)).toBe(input);
  });

  test("resample rejects a non-positive rate", () => {
    const r = createStreamingResampler();
    expect(() => r.process(Float32Array.from([0.1]), 0, 16_000)).toThrow(RangeError);
  });
});

describe("pcm16 codec", () => {
  test("round trip keeps samples within one LSB", () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.123]);
    const out = decodePcm16Base64(pcm16Base64(input));
    expect(out.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(Math.abs(out[i]! - input[i]!)).toBeLessThan(1 / 0x7fff + 1e-6);
    }
  });

  test("clamps out-of-range samples", () => {
    const out = decodePcm16Base64(pcm16Base64(Float32Array.from([2, -2])));
    expect(out[0]).toBeCloseTo(0x7fff / 0x8000, 6);
    expect(out[1]).toBe(-1);
  });

  test("rms level is 0 for silence and bounded for full scale", () => {
    expect(rmsLevel(new Float32Array(100))).toBe(0);
    expect(rmsLevel(new Float32Array(100).fill(1))).toBe(1);
  });
});
