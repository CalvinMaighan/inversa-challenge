/**
 * `prefers-reduced-motion: reduce`, read at the moment of the motion (the OS setting can change mid-session).
 * CSS animations are handled once in GlobalStyles; this is for motion driven from script: the card morph,
 * camera flights and canvas pulses.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
