import { set } from "@calvinjs/active-state";

import { setFishRange } from "client/carp/fish";
import { TIME, type TimeState } from "client/state/time";
import { timeWindow } from "client/state/time";

const DAY_MS = 86_400_000;

/** Put every timeline on the last `days` days: python and lionfish's TIME window, carp's sightings range. */
export function applyRange(days: number): void {
  const now = Date.now();
  set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...timeWindow(now, days), playing: false }));
  setFishRange(now - days * DAY_MS, now, now);
}
