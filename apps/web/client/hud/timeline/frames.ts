/**
 * TIME ↔ scrubber position ↔ frame-grid index.
 *
 * The scrubber has one position per 15-minute step of the TIME window (PLAN.md C15), so 30 days is 2,881
 * positions. The frame grid (PLAN.md C16) holds `frameCount` frames spread evenly over the same window:
 * frame 0 at `TIME.from`, frame `frameCount − 1` at `TIME.to`. At the 15-minute step the two coincide; with
 * hourly frames four positions share a frame. The grid header carries no timestamps, so this even spread is
 * the rule every reader (globe layers, HUD) applies.
 */
import { TIME_STEP_MINUTES } from "client/state/time";

export const STEP_MS = TIME_STEP_MINUTES * 60_000;

/** Number of scrubber positions minus one: whole steps between `from` and `to`. */
export function windowSteps(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / STEP_MS));
}

export function stepAt(atMs: number, fromMs: number, toMs: number): number {
  return Math.min(windowSteps(fromMs, toMs), Math.max(0, Math.round((atMs - fromMs) / STEP_MS)));
}

export function timeAtStep(step: number, fromMs: number): number {
  return fromMs + step * STEP_MS;
}

/** Grid frame for an instant, or -1 when there is no grid. */
export function frameIndexAt(atMs: number, fromMs: number, toMs: number, frameCount: number): number {
  if (frameCount <= 0) return -1;
  if (frameCount === 1 || toMs <= fromMs) return 0;
  const t = Math.min(1, Math.max(0, (atMs - fromMs) / (toMs - fromMs)));
  return Math.round(t * (frameCount - 1));
}

/** Instant a grid frame stands for. */
export function frameTimeMs(index: number, fromMs: number, toMs: number, frameCount: number): number {
  if (frameCount <= 1) return fromMs;
  return fromMs + (index / (frameCount - 1)) * (toMs - fromMs);
}
