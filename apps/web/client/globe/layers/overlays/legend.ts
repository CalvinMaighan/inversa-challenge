/**
 * The "Water and weather" group of the Layers popover (GE5), pure over the app config, LAYERS and the globe's
 * layer stats: one row per overlay the app lists, its plain-words line, legend with units, the instant it shows,
 * and the attribution lines of the sources that are on (the credit line carries them on the globe too).
 */
import type { LayerStats } from "client/globe/layers/types";
import type { LayersState } from "client/state/layers";
import { hasLayer, type AppConfig } from "shared/apps";
import { CYCLONES, OVERLAYS, shownTimeLine, type OverlayId, type OverlayLegend, type OverlaySpec } from "shared/overlays";

export const GROUP_LABEL = "Water and weather";

export type OverlayRow = {
  id: OverlayId;
  label: string;
  blurb: string;
  /** The config's own `description` when it has one, else the catalogue's blurb. */
  visible: boolean;
  legend: OverlayLegend;
  /** "Showing 19:36 UTC, 2026-10-01 (newest available)" once the layer drew; null while off or loading. */
  shown: string | null;
  /** Cyclones: "No active storms" once the feed answered with none; other layers null. */
  note: string | null;
  error: string | null;
  attribution: string;
  sourceUrl: string;
};

export function overlayRows(app: AppConfig, layers: Pick<LayersState, "visible">, stats: readonly LayerStats[] | null): OverlayRow[] {
  return OVERLAYS.filter((spec) => hasLayer(app, spec.id)).map((spec) => {
    const s = stats?.find((x) => x.id === spec.id) ?? null;
    const visible = layers.visible[spec.id] === true;
    const cfg = app.layers.find((l) => l.id === spec.id);
    return {
      id: spec.id,
      label: cfg?.label ?? spec.label,
      blurb: cfg?.description ?? spec.blurb,
      visible,
      legend: spec.legend,
      shown: visible && s?.overlay ? shownTimeLine(spec, s.overlay) : null,
      note: spec.id === CYCLONES && visible && s?.breakdown?.loaded === 1 ? (s.count === 0 ? "No active storms" : `${s.count} active storm${s.count === 1 ? "" : "s"}`) : null,
      error: s?.error ?? null,
      attribution: spec.attribution,
      sourceUrl: spec.sourceUrl,
    };
  });
}

/** Attribution lines of the overlays that are on, each once. */
export function activeAttributions(rows: readonly OverlayRow[]): { attribution: string; sourceUrl: string }[] {
  const seen = new Set<string>();
  return rows.filter((r) => r.visible && !seen.has(r.attribution) && seen.add(r.attribution)).map((r) => ({ attribution: r.attribution, sourceUrl: r.sourceUrl }));
}

/** CSS gradient of a ramp legend. */
export function rampCss(legend: Extract<OverlayLegend, { kind: "ramp" }>): string {
  const n = legend.stops.length - 1;
  return `linear-gradient(90deg, ${legend.stops.map((c, i) => `${c} ${Math.round((i / n) * 100)}%`).join(", ")})`;
}

export type { OverlaySpec };
