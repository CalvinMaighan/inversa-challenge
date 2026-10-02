/**
 * PCM helpers for voice mode. Pure functions; no Web Audio here.
 *
 * Resampler ported from qwen-audio-agent `web/src/realtime/audio.js`: linear
 * interpolation that keeps its phase between chunks so a continuous mic stream
 * resamples without seams.
 */

/** Web Audio hands out views over shared buffers, so accept any backing store. */
export type Samples = Float32Array<ArrayBufferLike>;

export type StreamingResampler = {
  process(input: Samples, from: number, to: number): Samples;
  flush(): Samples;
  reset(): void;
};

function assertRate(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} sample rate must be a positive number`);
  }
  return value;
}

function appendSamples(previous: Samples, input: Samples): Samples {
  const out = new Float32Array(previous.length + input.length);
  out.set(previous);
  out.set(input, previous.length);
  return out;
}

export function createStreamingResampler(): StreamingResampler {
  let inputRate = 0;
  let outputRate = 0;
  let pending: Samples = new Float32Array(0);
  let position = 0;
  let totalInput = 0;
  let outputCount = 0;

  const reset = () => {
    inputRate = 0;
    outputRate = 0;
    pending = new Float32Array(0);
    position = 0;
    totalInput = 0;
    outputCount = 0;
  };

  const configure = (from: number, to: number) => {
    const source = assertRate(from, "input");
    const target = assertRate(to, "output");
    if (source !== inputRate || target !== outputRate) {
      reset();
      inputRate = source;
      outputRate = target;
    }
  };

  const emit = (final: boolean): Samples => {
    const ratio = inputRate / outputRate;
    const targetCount = Math.max(1, Math.round(totalInput / ratio));
    const values: number[] = [];
    const step = () => {
      const before = Math.floor(position);
      const fraction = position - before;
      const after = Math.min(pending.length - 1, before + 1);
      values.push(pending[before]! * (1 - fraction) + pending[after]! * fraction);
      position += ratio;
      outputCount += 1;
    };
    while (position + 1 < pending.length && outputCount < targetCount) step();
    if (final) {
      while (position < pending.length && outputCount < targetCount) step();
    }
    const consumed = Math.min(pending.length, Math.floor(position));
    if (consumed > 0) {
      pending = pending.slice(consumed);
      position -= consumed;
    }
    return Float32Array.from(values);
  };

  return {
    process(input, from, to) {
      if (!input.length) return new Float32Array(0);
      configure(from, to);
      if (inputRate === outputRate) return input;
      pending = appendSamples(pending, input);
      totalInput += input.length;
      return emit(false);
    },
    flush() {
      if (!inputRate || !outputRate || inputRate === outputRate) {
        reset();
        return new Float32Array(0);
      }
      const out = emit(true);
      reset();
      return out;
    },
    reset,
  };
}

/** Float32 [-1, 1] → little-endian PCM16 base64. */
export function pcm16Base64(samples: Samples): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Little-endian PCM16 base64 → Float32 [-1, 1]. */
export function decodePcm16Base64(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export function concatFloat32(chunks: Samples[]): Float32Array<ArrayBuffer> {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** RMS level in [0, 1] for a simple mic meter. */
export function rmsLevel(samples: Samples): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}
