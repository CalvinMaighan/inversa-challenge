/**
 * Rect morph timing, ported from deedee `client/ui/interaction/morph/morph-timing.ts`. Three beats each way:
 * fade at the orb's size, morph to the card rect, fade the content in (reversed on close).
 */

export const MORPH_FADE_MS = 150;
export const MORPH_MS = 200;
export const MORPH_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

export type MorphTiming = { fadeMs: number; morphMs: number };

const FULL: MorphTiming = Object.freeze({ fadeMs: MORPH_FADE_MS, morphMs: MORPH_MS });
const INSTANT: MorphTiming = Object.freeze({ fadeMs: 0, morphMs: 0 });

/** Beat durations. Under `prefers-reduced-motion: reduce` every beat is 0 ms: the card appears in place. */
export function morphTiming(reducedMotion: boolean): MorphTiming {
  return reducedMotion ? INSTANT : FULL;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** CSS `transition` value for one beat. */
export function beat(ms: number): string {
  return `${ms}ms ${MORPH_EASE}`;
}
