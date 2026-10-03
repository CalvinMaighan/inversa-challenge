/**
 * TIME ↔ scrubber position, and grid frames on the TIME axis.
 *
 * The scrubber has one position per 15-minute step of the TIME window (PLAN.md C15), so 30 days is 2,881
 * positions. Which grid frame a time falls in is `frameIndexAt` from `client/threads/api` (PLAN.md C16):
 * frame i covers `[frame0 + i·step, frame0 + (i+1)·step)` of the published `FrameMeta`. With hourly frames
 * four scrubber positions share a frame; outside the grid there is no frame.
 */
import type { FrameMeta } from "client/threads/api";
import { TIME_STEP_MINUTES } from "client/state/time";

export const STEP_MS = TIME_STEP_MINUTES * 60_000;

/** A window longer than this plays a day a frame; a shorter one plays a step (15 minutes) a frame. */
export const DAY_PLAY_MIN_WINDOW_DAYS = 45;
const STEPS_PER_DAY = 96;

/**
 * Scrubber steps one play frame advances. A 2-year replay at 15 minutes a frame takes hours (8 frames a second is two
 * hours of data a second), so a long window plays a day a frame; the speed choices then mean days a second, and the
 * dots, counts and heat change once a day, which is the pace the data itself moves at. A short window keeps the fine steps.
 */
export function playStride(fromMs: number, toMs: number): number {
  return toMs - fromMs > DAY_PLAY_MIN_WINDOW_DAYS * 86_400_000 ? STEPS_PER_DAY : 1;
}

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

/** Time span of grid frames `[start, end)`, for drawing them on the timeline. */
export function framesSpanMs(start: number, end: number, meta: FrameMeta): [number, number] {
  const step = meta.stepMinutes * 60_000;
  return [meta.frame0UnixMs + start * step, meta.frame0UnixMs + end * step];
}
