/**
 * The one time every globe layer draws at (GE7, docs/GODS_EYE.md GC6 "each layer follows the timeline"). A species
 * app's timeline is TIME (the HUD timeline). A conditions app (carp) has no TIME timeline: its timeline is the stage
 * chart's "what we knew" cursor, CARP.asOf, and live (now) when that is unset; its play button is CARP.replay. The
 * viewer hands `layerClock()` to the layers as `LayerContext.timeMs` and `playing`, and refreshes them when TIME or
 * CARP changes, so ships, alerts, stations and the water and weather overlays all follow the same cursor and no
 * layer subscribes to CARP itself.
 */
import { get } from "@calvinjs/active-state";

import { activeApp } from "client/state/app";
import { CARP, type CarpState } from "client/state/carp";
import { TIME, type TimeState } from "client/state/time";
import type { AppConfig } from "shared/apps";

type AppKind = AppConfig["kind"];

/** The cursor, unix ms: CARP.asOf (now when live) in a conditions app, TIME.at in a species app. */
export function layerTimeMs(kind: AppKind, carp: CarpState | undefined, timeAt: string, nowMs: number): number {
  if (kind === "conditions") {
    const asOf = carp?.asOf;
    return typeof asOf === "number" && Number.isFinite(asOf) ? asOf : nowMs;
  }
  return Date.parse(timeAt);
}

/** The timeline is playing: CARP.replay in a conditions app, TIME.playing in a species app. */
export function layerPlaying(kind: AppKind, carp: CarpState | undefined, timePlaying: boolean): boolean {
  return kind === "conditions" ? carp?.replay === true && carp.asOf !== undefined : timePlaying;
}

/** The live reading of both, from the active app, CARP and TIME. */
export function layerClock(now: () => number = Date.now): { timeMs(): number; playing(): boolean } {
  const time = () => ({ ...TIME.defaults, ...get<TimeState>(TIME) });
  return {
    timeMs: () => layerTimeMs(activeApp().kind, get<CarpState>(CARP), time().at, now()),
    playing: () => layerPlaying(activeApp().kind, get<CarpState>(CARP), time().playing),
  };
}
