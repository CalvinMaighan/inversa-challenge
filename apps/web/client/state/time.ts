import { key } from "@calvinjs/active-state";

/** Frame step and replay window (PLAN.md C15). */
export const TIME_STEP_MINUTES = 15;
export const TIME_WINDOW_DAYS = 30;
/** Playback speed in frames per second; the `play_timeline` voice tool uses the same default. */
export const DEFAULT_SPEED = 8;

const STEP_MS = TIME_STEP_MINUTES * 60_000;
const WINDOW_MS = TIME_WINDOW_DAYS * 24 * 60 * 60_000;

export type TimeState = {
  /** Cursor, RFC 3339 UTC, on a frame step. The Cesium clock and every layer follow it. */
  at: string;
  playing: boolean;
  speed: number;
  /** Replay window bounds, RFC 3339 UTC. */
  from: string;
  to: string;
};

/** Replay window ending at the frame step that contains `nowMs`, with the cursor on the live edge. */
export function timeWindow(nowMs: number): Pick<TimeState, "at" | "from" | "to"> {
  const to = Math.floor(nowMs / STEP_MS) * STEP_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { at: iso(to), from: iso(to - WINDOW_MS), to: iso(to) };
}

/** Snap an instant to the frame grid and clamp it into [from, to]. */
export function clampToWindow(atMs: number, time: Pick<TimeState, "from" | "to">): string {
  const from = Date.parse(time.from);
  const to = Date.parse(time.to);
  const snapped = Math.round(atMs / STEP_MS) * STEP_MS;
  return new Date(Math.min(to, Math.max(from, snapped))).toISOString();
}

/**
 * Defaults are taken at module load. Server and browser load at different moments, so SSR must not render
 * text from TIME; the HUD and globe that read it are client-only.
 */
const defaults: TimeState = { ...timeWindow(Date.now()), playing: false, speed: DEFAULT_SPEED };

export const TIME = key("TIME", defaults);
