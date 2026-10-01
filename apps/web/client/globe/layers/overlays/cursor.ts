/**
 * The instant an overlay follows (GC6 "each layer follows the timeline"). Species apps have the HUD timeline
 * (TIME); the carp app's timeline is its stage chart's "what we knew" cursor (CARP.asOf), live when unset.
 */
import { get, subscribe } from "@calvinjs/active-state";

import { activeAppId } from "client/state/app";
import { CARP, type CarpState } from "client/state/carp";
import { APP_IDS } from "shared/apps";

import type { LayerContext } from "../types";

const [CARP_APP] = APP_IDS;

export function overlayCursorMs(ctx: Pick<LayerContext, "timeMs">): number {
  if (activeAppId() === CARP_APP) {
    const asOf = get<CarpState>(CARP)?.asOf;
    if (typeof asOf === "number" && Number.isFinite(asOf)) return asOf;
  }
  return ctx.timeMs();
}

/** Fires when carp's cursor moves (TIME changes already reach layers through the globe's refresh). */
export function onCarpCursor(cb: () => void): () => void {
  return subscribe(CARP, cb);
}
