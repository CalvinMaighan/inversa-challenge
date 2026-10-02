import { decodePcm16Base64 } from "./pcm";

/** Web Audio timeline headroom so a freshly scheduled source is not already late. */
const SCHEDULING_LEAD_S = 0.02;

export type PlaybackReceipt = "started" | "ended" | "cancelled";

export type PcmPlayback = {
  push(responseId: string, base64: string, sampleRate: number): void;
  /** No more audio for this response; `ended` fires once the last source drains. */
  finish(responseId: string): void;
  /** Barge-in: stop everything now. Emits `cancelled` for each response cut off. */
  clear(): void;
  isPlaying(): boolean;
  dispose(): void;
};

type ResponseTrack = {
  sources: Set<AudioBufferSourceNode>;
  started: boolean;
  finished: boolean;
};

/**
 * Schedules PCM chunks back to back on one AudioContext and reports playback
 * receipts per response id. Receipts drive the server's announcement window,
 * so they must reflect what the user actually heard, not what was decoded.
 */
export function createPcmPlayback(
  context: AudioContext,
  onReceipt: (responseId: string, state: PlaybackReceipt) => void,
): PcmPlayback {
  const tracks = new Map<string, ResponseTrack>();
  let cursor = 0;

  const track = (responseId: string): ResponseTrack => {
    let t = tracks.get(responseId);
    if (!t) {
      t = { sources: new Set(), started: false, finished: false };
      tracks.set(responseId, t);
    }
    return t;
  };

  const settle = (responseId: string) => {
    const t = tracks.get(responseId);
    if (!t || !t.finished || t.sources.size > 0) return;
    tracks.delete(responseId);
    if (t.started) onReceipt(responseId, "ended");
  };

  return {
    push(responseId, base64, sampleRate) {
      const samples = decodePcm16Base64(base64);
      if (!samples.length) return;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const t = track(responseId);
      t.sources.add(source);
      const startAt = Math.max(cursor, context.currentTime + SCHEDULING_LEAD_S);
      cursor = startAt + buffer.duration;
      source.onended = () => {
        t.sources.delete(source);
        settle(responseId);
      };
      source.start(startAt);
      if (!t.started) {
        t.started = true;
        onReceipt(responseId, "started");
      }
    },
    finish(responseId) {
      track(responseId).finished = true;
      settle(responseId);
    },
    clear() {
      for (const [responseId, t] of tracks) {
        for (const source of t.sources) {
          source.onended = null;
          try {
            source.stop();
          } catch {
            /* not started yet */
          }
        }
        tracks.delete(responseId);
        onReceipt(responseId, "cancelled");
      }
      cursor = 0;
    },
    isPlaying() {
      for (const t of tracks.values()) if (t.sources.size > 0) return true;
      return false;
    },
    dispose() {
      for (const t of tracks.values()) {
        for (const source of t.sources) {
          source.onended = null;
          try {
            source.stop();
          } catch {
            /* ignore */
          }
        }
      }
      tracks.clear();
    },
  };
}
