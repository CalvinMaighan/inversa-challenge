/**
 * TIME cursor to frame index for the globe (PLAN.md C16). `frameIndexAt` from the threads API floors
 * `(at - frame0) / step` and returns null outside the published grid; the layers take -1 for "no frame".
 */
import { frameIndexAt, type FrameMeta } from "client/threads/api";

/** Frame containing `atMs`, or -1 when no grid is published or the instant is outside it. */
export function frameForTime(atMs: number, meta: FrameMeta | null): number {
  if (!Number.isFinite(atMs)) return -1;
  return frameIndexAt(atMs, meta) ?? -1;
}

export function stepMsOf(meta: Pick<FrameMeta, "stepMinutes">): number {
  return meta.stepMinutes * 60_000;
}

/** Start instant of frame `index`, in unix ms. */
export function frameStartMs(index: number, frame0Ms: number, stepMs: number): number {
  return frame0Ms + index * stepMs;
}
