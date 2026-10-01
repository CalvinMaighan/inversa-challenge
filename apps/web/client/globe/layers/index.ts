import { createAlertsLayer } from "./alerts";
import { createLstLayer, createSstLayer } from "./env-raster";
import { createHotspotLayer } from "./hotspots";
import { createMissionsLayer } from "./missions";
import { createNotesLayer } from "./notes";
import { createPeersLayer } from "./peers";
import { createSightingsLayer } from "./sightings";
import { createStationsLayer } from "./stations";
import type { GlobeLayer, LayerContext } from "./types";

/** Every layer, bottom to top: rasters, then alert areas, then point features, then people. */
export function createLayers(ctx: LayerContext): GlobeLayer[] {
  return [
    createLstLayer(ctx),
    createSstLayer(ctx),
    createHotspotLayer(ctx),
    createAlertsLayer(ctx),
    createStationsLayer(ctx),
    createSightingsLayer(ctx),
    createMissionsLayer(ctx),
    createNotesLayer(ctx),
    createPeersLayer(ctx),
  ];
}

export type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "./types";
