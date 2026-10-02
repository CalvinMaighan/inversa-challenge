import { key } from "@calvinjs/active-state";

/** The newest record time (ms) the viewer has seen in the Live data popover: a newer one lights the dot on its button. 0 until the first feeds arrive. */
export const ALERTS_SEEN = key("ALERTS_SEEN", 0);
