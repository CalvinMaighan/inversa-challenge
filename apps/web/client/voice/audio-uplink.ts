import { concatFloat32, decodePcm16Base64, pcm16Base64 } from "./pcm";

/** Decode, concatenate, re-encode. Base64 strings cannot be joined directly. */
export function mergePcm16Base64(chunks: readonly string[]): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0]!;
  return pcm16Base64(concatFloat32(chunks.map((chunk) => decodePcm16Base64(chunk))));
}

/**
 * One audio POST at a time. Capture calls `push` and returns.
 * Samples that arrive while a send is in flight leave in the next body, in order.
 */
export function createAudioUplink(
  send: (audio: string) => Promise<void>,
  opts?: { hold?: boolean },
): {
  push(audio: string): void;
  open(): void;
  stop(): void;
} {
  let inFlight = false;
  let stopped = false;
  let open = !opts?.hold;
  let pending: string[] = [];

  const pump = (): void => {
    if (stopped || !open || inFlight || pending.length === 0) return;
    const batch = pending;
    pending = [];
    inFlight = true;
    void send(mergePcm16Base64(batch)).finally(() => {
      inFlight = false;
      if (!stopped) pump();
    });
  };

  return {
    push(audio: string) {
      if (stopped || !audio) return;
      pending.push(audio);
      pump();
    },
    open() {
      if (stopped || open) return;
      open = true;
      pump();
    },
    stop() {
      stopped = true;
      pending = [];
    },
  };
}
