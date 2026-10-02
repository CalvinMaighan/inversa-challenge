import { key } from "@calvinjs/active-state";

/** Frame step and replay window (PLAN.md C15). */
export const TIME_STEP_MINUTES = 15;
export const TIME_WINDOW_DAYS = 365;
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

/** Replay window of `days` (the default window) ending at the frame step that contains `nowMs`, with the cursor on the live edge. */
export function timeWindow(nowMs: number, days: number = TIME_WINDOW_DAYS): Pick<TimeState, "at" | "from" | "to"> {
  const to = Math.floor(nowMs / STEP_MS) * STEP_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { at: iso(to), from: iso(to - days * 24 * 60 * 60_000), to: iso(to) };
}

/** Snap an instant to the frame grid and clamp it into [from, to]. */
export function clampToWindow(atMs: number, time: Pick<TimeState, "from" | "to">): string {
  const from = Date.parse(time.from);
  const to = Date.parse(time.to);
  const snapped = Math.round(atMs / STEP_MS) * STEP_MS;
  return new Date(Math.min(to, Math.max(from, snapped))).toISOString();
}

/**
 * The window that shows `atMs`, with the cursor on it. At or after the start of the live window (the 30 days
 * ending `nowMs`) that is the live window, cursor clamped to its edge; earlier, a 30-day window centred on
 * `atMs`. The frame axis follows the window bounds, so moving them makes the db worker fetch that window.
 */
export function windowFor(atMs: number, nowMs: number): Pick<TimeState, "at" | "from" | "to"> {
  const live = timeWindow(nowMs);
  if (atMs >= Date.parse(live.from)) return { ...live, at: clampToWindow(atMs, live) };
  const from = Math.round((atMs - WINDOW_MS / 2) / STEP_MS) * STEP_MS;
  const window = { from: new Date(from).toISOString(), to: new Date(from + WINDOW_MS).toISOString() };
  return { ...window, at: clampToWindow(atMs, window) };
}

/** Move the cursor to `atMs`: inside the current window only the cursor moves, outside it the window follows. */
export function retime(prev: Pick<TimeState, "from" | "to">, atMs: number, nowMs: number): Pick<TimeState, "at" | "from" | "to"> {
  const from = Date.parse(prev.from);
  const to = Date.parse(prev.to);
  if (Number.isFinite(from) && Number.isFinite(to) && atMs >= from && atMs <= to) {
    return { from: prev.from, to: prev.to, at: clampToWindow(atMs, prev) };
  }
  return windowFor(atMs, nowMs);
}

/** The longest period the timeline may span: the db worker fetches every frame of it. */
export const MAX_RANGE_DAYS = 366;

/**
 * The window from the start of UTC day `startMs` to the end of UTC day `endMs` (or now, for today), cursor at its end,
 * kept within `MAX_RANGE_DAYS`: when the span is too long the end that was not just edited (`edited`) gives way.
 */
export function rangeWindow(startMs: number, endMs: number, nowMs: number, edited: "start" | "end"): Pick<TimeState, "at" | "from" | "to"> {
  const day = 24 * 60 * 60_000;
  const nowStep = Math.floor(nowMs / STEP_MS) * STEP_MS;
  const endOf = (ms: number) => Math.min(nowStep, Math.floor(ms / day) * day + day - STEP_MS);
  let from = Math.min(Math.floor(startMs / day) * day, nowStep - STEP_MS);
  let to = endOf(endMs);
  if (to <= from) {
    if (edited === "start") to = endOf(from);
    else from = Math.floor(to / day) * day;
  }
  const max = MAX_RANGE_DAYS * day;
  if (to - from > max) {
    if (edited === "start") to = endOf(from + max);
    else from = Math.floor((to - max) / day) * day;
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  return { from: iso(from), to: iso(to), at: iso(to) };
}

/**
 * Defaults are taken at module load. Server and browser load at different moments, so SSR must not render
 * text from TIME; the HUD and globe that read it are client-only.
 */
const defaults: TimeState = { ...timeWindow(Date.now()), playing: false, speed: DEFAULT_SPEED };

export const TIME = key("TIME", defaults);
