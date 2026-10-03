import { INTRO_ATTR } from "./constants";

/**
 * Whether the first-run gate is still up. The apps' own first-view framing (carp's basin, lionfish's reef, python's
 * area) skips while it is: the camera stays fully zoomed out behind the gate, and the gate flies it on entry.
 */
export function gateOpen(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(INTRO_ATTR);
}
