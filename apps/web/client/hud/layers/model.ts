/**
 * The Layers popover (docs/GODS_EYE.md GC1, GC6; GE7): what a newcomer may switch on the map, in plain words. Pure
 * over LAYERS, the globe's stats and the app config, built from the legend's own rows (client/hud/legend/model.ts)
 * and the "Water and weather" rows (client/globe/layers/overlays/legend.ts), so the popover holds no state of its
 * own: every switch writes LAYERS, the same key the expert legend and the agent write.
 *
 *   On the map        sightings, field notes (on at first load: the novice rule)
 *   Ships             vessels, carp and lionfish only (off at first load)
 *   Water and weather the app's overlays (off at first load), rendered by WaterWeather
 */
import { overlayRows } from "client/globe/layers/overlays/legend";
import type { LayerStats } from "client/globe/layers/types";
import type { LayerId, LayersState } from "client/state/layers";
import { LAYER_IDS, type AppConfig } from "shared/apps";

import { legendRows, type LegendRow } from "../legend/model";

const [SIGHTINGS, , , , , , , , NOTES, VESSELS] = LAYER_IDS;

export type LayersGroup = { id: "map" | "ships"; label: string; rows: LegendRow[] };

/** One plain line per layer, shorter than the legend's how-to-read note. */
export const LAYER_BLURBS: Partial<Record<LayerId, string>> = {
  [SIGHTINGS]: "Where people reported the species, newest brightest. Click one to see the record.",
  [NOTES]: "Pins your team dropped with a note from the field.",
  [VESSELS]: "Ships that broadcast their position (AIS), moving with the timeline. Not every boat does.",
};

const GROUPS: readonly { id: LayersGroup["id"]; label: string; layers: readonly LayerId[] }[] = [
  { id: "map", label: "On the map", layers: [SIGHTINGS, NOTES] },
  { id: "ships", label: "Ships", layers: [VESSELS] },
];

/** The popover's own groups for the active app; a group the app lists no layer of is left out. */
export function layersGroups(layers: LayersState, stats: readonly LayerStats[] | null, app: AppConfig): LayersGroup[] {
  const rows = legendRows(layers, stats, app);
  return GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    rows: g.layers.flatMap((id) => rows.filter((r) => r.layer === id).map((r) => ({ ...r, note: LAYER_BLURBS[id] ?? r.note, group: undefined }))),
  })).filter((g) => g.rows.length > 0);
}

/** Every layer the popover switches, in order (its groups, then the water and weather overlays). */
export function layersBarIds(layers: LayersState, app: AppConfig): LayerId[] {
  return [...layersGroups(layers, null, app).flatMap((g) => g.rows.map((r) => r.layer)), ...overlayRows(app, layers, null).map((r) => r.id)];
}

/** The layers the popover shows switched on. */
export function layersOn(layers: LayersState, app: AppConfig): LayerId[] {
  return [...layersGroups(layers, null, app).flatMap((g) => g.rows.filter((r) => r.visible).map((r) => r.layer)), ...overlayRows(app, layers, null).filter((r) => r.visible).map((r) => r.id)];
}
