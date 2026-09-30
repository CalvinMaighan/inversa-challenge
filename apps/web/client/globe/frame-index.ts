/**
 * TIME cursor to frame index (PLAN.md C16): `(at - frame0) / step`, floored because a frame covers
 * `[frame_at, frame_at + step)`, and clamped into the resident grid. Pure, so the scrubber and tests share it.
 */

/** Index of the frame containing `atMs`, clamped to `[0, frameCount)`; -1 when there is no frame to show. */
export function frameIndexAt(atMs: number, frame0Ms: number, stepMs: number, frameCount: number): number {
  if (!(frameCount > 0) || !(stepMs > 0) || !Number.isFinite(atMs) || !Number.isFinite(frame0Ms)) return -1;
  // The epsilon absorbs float error when `at` sits exactly on a step boundary.
  const raw = Math.floor((atMs - frame0Ms) / stepMs + 1e-9);
  return Math.min(frameCount - 1, Math.max(0, raw));
}

/** Start instant of frame `index`, in unix ms. */
export function frameStartMs(index: number, frame0Ms: number, stepMs: number): number {
  return frame0Ms + index * stepMs;
}

/**
 * Timeline for a grid published without one: the resident window is assumed to end on the live edge
 * (`toMs`, TIME.to) at the TIME step, which is how the db worker fills it.
 */
export function assumedFrame0(toMs: number, stepMs: number, frameCount: number): number {
  return toMs - Math.max(0, frameCount - 1) * stepMs;
}
