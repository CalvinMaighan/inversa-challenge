/**
 * The five water and weather overlays (docs/GODS_EYE.md GC5), in draw order: the SST map under the weather
 * rasters, storms on top. Each follows the timeline, defaults off and lives under "Water and weather" in the
 * Layers popover.
 */
import { CLOUDS, LIGHTNING, RADAR, SST_MAP } from "shared/overlays";

import type { GlobeLayer, LayerContext } from "../types";
import { createCyclonesLayer } from "./cyclones";
import { createOverlayRasterLayer } from "./raster";

export function createOverlayLayers(ctx: LayerContext): GlobeLayer[] {
  return [createOverlayRasterLayer(SST_MAP, ctx), createOverlayRasterLayer(RADAR, ctx), createOverlayRasterLayer(CLOUDS, ctx), createOverlayRasterLayer(LIGHTNING, ctx), createCyclonesLayer(ctx)];
}

export { createCyclonesLayer, cycloneLabel, CYCLONE_ID_PREFIX } from "./cyclones";
export { overlayOpacity, setOverlayOpacity, subscribeOverlayOpacity } from "./opacity";
export { createOverlayRasterLayer } from "./raster";
