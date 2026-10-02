import { VOICE_AUDIO_BATCH_MS, VOICE_INPUT_SAMPLE_RATE } from "shared/voice/protocol";

import {
  concatFloat32,
  createStreamingResampler,
  pcm16Base64,
  rmsLevel,
  type Samples,
} from "./pcm";

/** AudioWorklet processor: forwards mono Float32 blocks to the main thread. */
const WORKLET_SOURCE = `
class InversaMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("inversa-mic", InversaMicProcessor);
`;

export type MicCapture = {
  stop(): void;
  /** Mute forwards silence so provider VAD keeps advancing without picking up the room. */
  setMuted(muted: boolean): void;
};

export type MicCaptureHandlers = {
  onBatch: (base64: string) => void;
  onLevel?: (level: number) => void;
  onError: (error: Error) => void;
};

/**
 * Capture the microphone, resample to the provider input rate, and emit
 * PCM16 batches every `VOICE_AUDIO_BATCH_MS`. Falls back to ScriptProcessor
 * where AudioWorklet is unavailable.
 */
const MIC_AUDIO = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

async function openMicStream(deviceId: string): Promise<MediaStream> {
  const exact = deviceId
    ? { ...MIC_AUDIO, deviceId: { exact: deviceId } }
    : MIC_AUDIO;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: exact });
  } catch (error) {
    if (!deviceId) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO });
  }
}

export async function startMicCapture(
  context: AudioContext,
  handlers: MicCaptureHandlers,
  deviceId = "",
): Promise<MicCapture> {
  const stream = await openMicStream(deviceId);
  const source = context.createMediaStreamSource(stream);
  const resampler = createStreamingResampler();
  const batchSamples = Math.round((VOICE_INPUT_SAMPLE_RATE * VOICE_AUDIO_BATCH_MS) / 1000);
  let buffered: Samples[] = [];
  let bufferedLength = 0;
  let muted = false;
  let stopped = false;

  const flush = () => {
    if (bufferedLength === 0) return;
    const all = concatFloat32(buffered);
    buffered = [];
    bufferedLength = 0;
    handlers.onBatch(pcm16Base64(all));
  };

  const onSamples = (input: Samples) => {
    if (stopped) return;
    handlers.onLevel?.(muted ? 0 : rmsLevel(input));
    const block = muted ? new Float32Array(input.length) : input;
    const out = resampler.process(block, context.sampleRate, VOICE_INPUT_SAMPLE_RATE);
    if (!out.length) return;
    buffered.push(out);
    bufferedLength += out.length;
    if (bufferedLength >= batchSamples) flush();
  };

  let node: AudioNode;
  let disconnect: () => void;
  if (typeof AudioWorkletNode === "function" && context.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const worklet = new AudioWorkletNode(context, "inversa-mic", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    worklet.port.onmessage = (event: MessageEvent<Samples>) => onSamples(event.data);
    source.connect(worklet);
    node = worklet;
    disconnect = () => {
      worklet.port.onmessage = null;
      source.disconnect(worklet);
    };
  } else {
    const processor = context.createScriptProcessor(2048, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0).slice(0));
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    node = processor;
    disconnect = () => {
      processor.onaudioprocess = null;
      source.disconnect(processor);
      processor.disconnect();
      sink.disconnect();
    };
  }

  const onTrackEnded = () => handlers.onError(new Error("Microphone disconnected"));
  for (const track of stream.getAudioTracks()) track.addEventListener("ended", onTrackEnded);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      flush();
      disconnect();
      void node;
      for (const track of stream.getTracks()) {
        track.removeEventListener("ended", onTrackEnded);
        track.stop();
      }
    },
    setMuted(next) {
      muted = next;
    },
  };
}
