/**
 * The Layers legend (T40): one row per globe layer with what its marks mean, its toggle state and what it
 * draws right now, plus the data-gaps row. Pure over LAYERS and the globe's layer stats, so every colour in the
 * legend is the colour the layer actually uses (imported, never retyped).
 */
import { severityColor } from "client/globe/layers/alerts";
import { statusColor } from "client/globe/layers/missions";
import { OTHER_TAXA_KEY } from "client/globe/layers/sightings";
import { STATION_SOURCES, stationColor } from "client/globe/layers/stations";
import type { LayerStats } from "client/globe/layers/types";
import { HATCH_RGBA, HEAT_STOPS, LST_RANGE_C, SST_RANGE_C, TEMP_STOPS, type RampStop } from "client/globe/ramp";
import { OTHER_TAXON_COLOR, SPECIES_COLORS } from "client/globe/species";
import type { LayerId, LayersState, SpeciesId } from "client/state/layers";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import { NETWORK_LABELS, OTHER_SPECIES_NAME, SPECIES_NAMES } from "../tooltip/model";

const [SIGHTINGS, HOTSPOTS, LST, SST, STATIONS, ALERTS, MISSIONS, PEERS] = LAYER_IDS;

export type SwatchShape = "dot" | "square" | "diamond" | "area" | "hatch";

export type LegendSwatch = {
  key: string;
  label: string;
  color: string;
  shape: SwatchShape;
  /** What the layer draws of this kind right now; null when the layer does not count it separately. */
  count: number | null;
  /** Species sub-rows toggle through `setSpeciesVisible`. */
  species?: SpeciesId;
  /** Species filter state, for species sub-rows. */
  on?: boolean;
};

export type LegendRamp = { css: string; min: string; max: string; caption: string };

export type LegendRow = {
  layer: LayerId;
  label: string;
  /** One line on how to read the marks. */
  note: string;
  visible: boolean;
  /** Drawn right now (null before the globe reported stats). */
  count: number | null;
  /** Unit of `count`, e.g. "cells". */
  unit: string;
  swatches: LegendSwatch[];
  ramp?: LegendRamp;
  /** Hotspots can be pinned to one species. */
  pin?: SpeciesId | null;
  /** Layer error from its last fetch, shown under the row. */
  error: string | null;
};

/** CSS gradient through a ramp's colours, opaque so the hue run reads on any theme. */
export function rampGradient(stops: readonly RampStop[]): string {
  return `linear-gradient(90deg, ${stops.map(([t, r, g, b]) => `rgb(${r} ${g} ${b}) ${Math.round(t * 100)}%`).join(", ")})`;
}

/** The globe's raster hatch colour as CSS. */
export const HATCH_COLOR = `rgb(${HATCH_RGBA[0]} ${HATCH_RGBA[1]} ${HATCH_RGBA[2]} / ${(HATCH_RGBA[3] / 255).toFixed(2)})`;

/** Count with thousands separators; an em dash before the globe reported. */
export function formatCount(count: number | null): string {
  return count === null || !Number.isFinite(count) ? "—" : Math.round(count).toLocaleString("en-US");
}

const statsFor = (stats: readonly LayerStats[] | null, id: LayerId) => stats?.find((s) => s.id === id) ?? null;
const part = (s: LayerStats | null, key: string): number | null => (s?.breakdown ? (s.breakdown[key] ?? 0) : null);

const SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor"] as const;

/** Every legend row, in globe draw order top-down as a reader scans the map: points first, rasters last. */
export function legendRows(layers: LayersState, stats: readonly LayerStats[] | null): LegendRow[] {
  const row = (layer: LayerId, rest: Omit<LegendRow, "layer" | "visible" | "count" | "error">): LegendRow => {
    const s = statsFor(stats, layer);
    return { layer, visible: layers.visible[layer] !== false, count: s ? s.count : null, error: s?.error ?? null, ...rest };
  };
  const sightings = statsFor(stats, SIGHTINGS);
  const stationStats = statsFor(stats, STATIONS);
  const pinned = layers.species[HOTSPOTS];

  return [
    row(SIGHTINGS, {
      label: "Sightings",
      note: "One dot per report in the last 24 h, fading with age. Red ring: the IDs conflict.",
      unit: "drawn",
      swatches: [
        ...SPECIES_IDS.map((id, i) => ({
          key: id,
          label: SPECIES_NAMES[i]!,
          color: SPECIES_COLORS[i]!,
          shape: "dot" as const,
          count: part(sightings, id),
          species: id,
          on: layers.species[id] !== false,
        })),
        { key: OTHER_TAXA_KEY, label: OTHER_SPECIES_NAME, color: OTHER_TAXON_COLOR, shape: "dot", count: part(sightings, OTHER_TAXA_KEY) },
      ],
    }),
    row(STATIONS, {
      label: "Stations",
      note: "Squares: in-situ stations that reported in the 2 h before the cursor.",
      unit: "reporting",
      swatches: STATION_SOURCES.map((src) => ({ key: src, label: NETWORK_LABELS[src]!, color: stationColor(src), shape: "square" as const, count: part(stationStats, src) })),
    }),
    row(ALERTS, {
      label: "Alerts",
      note: "NWS warnings and advisories in effect at the cursor, outlined by severity.",
      unit: "in effect",
      swatches: SEVERITIES.map((sev) => ({ key: sev.toLowerCase(), label: sev, color: severityColor(sev), shape: "area" as const, count: null })),
    }),
    row(HOTSPOTS, {
      label: "Hotspots",
      note: "Where crews are likeliest to find animals in this frame. A heuristic, not a forecast.",
      unit: "cells",
      swatches: [],
      ramp: { css: rampGradient(HEAT_STOPS), min: "low", max: "high", caption: "heuristic score" },
      pin: typeof pinned === "string" ? pinned : null,
    }),
    row(MISSIONS, {
      label: "Missions",
      note: "Team missions on the board, by status. Click one to open it in the Missions tab.",
      unit: "on the board",
      swatches: [
        { key: "planned", label: "Planned", color: statusColor("planned"), shape: "diamond", count: null },
        { key: "active", label: "In progress", color: statusColor("active"), shape: "diamond", count: null },
        { key: "done", label: "Done", color: statusColor("done"), shape: "diamond", count: null },
      ],
    }),
    row(PEERS, {
      label: "Team cursors",
      note: "Where teammates on this board are pointing, in their own colour with their callsign.",
      unit: "online",
      swatches: [],
    }),
    row(LST, {
      label: "Land surface temp (LST)",
      note: "GOES land surface temperature on a 0.05° grid.",
      unit: "cells",
      swatches: [],
      ramp: { css: rampGradient(TEMP_STOPS), min: `${LST_RANGE_C.min} °C`, max: `${LST_RANGE_C.max} °C`, caption: "°C" },
    }),
    row(SST, {
      label: "Sea surface temp (SST)",
      note: "Sea surface temperature on a 0.05° grid.",
      unit: "cells",
      swatches: [],
      ramp: { css: rampGradient(TEMP_STOPS), min: `${SST_RANGE_C.min} °C`, max: `${SST_RANGE_C.max} °C`, caption: "°C" },
    }),
  ];
}

/** The data-gaps row: what the hatching on the rasters and the timeline means. Colours are CSS (theme tokens). */
export const GAP_SWATCHES: readonly { key: string; label: string; color: string; where: string }[] = [
  { key: "cloud-cell", label: "Cloud or masked", color: HATCH_COLOR, where: "LST and SST cells missing in this frame" },
  { key: "no-data", label: "No data", color: "var(--danger)", where: "timeline: the satellite feed delivered nothing" },
  { key: "cloud", label: "Cloud", color: "var(--warn)", where: "timeline: half or more of the region under cloud" },
  { key: "quiet", label: "Quiet", color: "var(--muted)", where: "timeline: no sightings for 12 h or more" },
];
