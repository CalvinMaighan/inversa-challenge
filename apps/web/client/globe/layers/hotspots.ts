/**
 * Hotspot heatmap: the per-cell maximum of the enabled species' u8 grids (C4, 0.02°, 170 × 160), through the
 * heat ramp, on a ground rectangle over the grid's bounds. A frame change repaints the canvas in place;
 * scrubbing never allocates or touches the network.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import { isSurveyApp } from "client/lionfish/model";
import { activeApp } from "client/state/app";
import type { BBox } from "shared/agent/events";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { hotspotEvidenceId } from "../evidence";
import { frameStartMs, stepMsOf } from "../frame-index";
import { boundsKey, cellAt, gridBounds } from "../geometry";
import { heatLut, paintHeat } from "../ramp";
import { enabledSpecies } from "../species";
import { createRasterSurface, type RasterSurface } from "./raster-surface";
import { RASTER_PICK_PREFIX, type GlobeLayer, type GlobeViewer, type LayerContext, type LayerStats } from "./types";

const [, HOTSPOTS] = LAYER_IDS;

export function createHotspotLayer(ctx: LayerContext): GlobeLayer {
  const lut = heatLut();
  let viewer: GlobeViewer | null = null;
  let surface: RasterSurface | null = null;
  let surfaceKey = "";
  let enabled = false;
  let drawnKey = "";
  let shown: { grid: FrameGrid; frame: number; species: number[]; bounds: BBox } | null = null;
  const stats: LayerStats = { id: HOTSPOTS, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };
  /** The cell `pickAt` resolved last, so `describe` can give its score without reading the grid again. */
  let lastPick: { id: string; species: number; score: number } | null = null;

  const ensureSurface = (grid: FrameGrid, bounds: BBox): RasterSurface | null => {
    if (!viewer) return null;
    const key = `${grid.shape.hsCols}x${grid.shape.hsRows}@${boundsKey(bounds)}`;
    if (surface && surfaceKey === key) return surface;
    surface?.destroy();
    surface = createRasterSurface(viewer, {
      pickId: `${RASTER_PICK_PREFIX}${HOTSPOTS}`,
      bbox: bounds,
      width: grid.shape.hsCols,
      height: grid.shape.hsRows,
    });
    surfaceKey = key;
    return surface;
  };

  const hide = () => {
    surface?.setShow(false);
    shown = null;
    drawnKey = "";
    stats.count = 0;
  };

  return {
    id: HOTSPOTS,
    init(v) {
      viewer = v;
    },
    enable() {
      enabled = stats.enabled = true;
    },
    disable() {
      enabled = stats.enabled = false;
      if (surface) {
        hide();
        ctx.requestRender();
      }
    },
    update(frameIndex, grid) {
      if (!enabled) return;
      // A survey app (Lionfish Watch) draws its ranked cells itself, components kept apart.
      if (!grid || isSurveyApp(activeApp()) || frameIndex < 0 || frameIndex >= grid.shape.frameCount || grid.shape.speciesCount === 0 || grid.layout.hsCells === 0) {
        if (shown) {
          hide();
          ctx.requestRender();
        }
        return;
      }
      const bounds = gridBounds(grid.shape, ctx.meta()?.geometry).hotspot;
      const species = enabledSpecies(ctx.layers().species).filter((s) => s < grid.shape.speciesCount);
      const key = `${frameIndex}|${grid.version()}|${species.join(",")}|${grid.buffer.byteLength}|${boundsKey(bounds)}|${ctx.revision()}`;
      if (key === drawnKey && shown?.grid === grid) return;
      const target = ensureSurface(grid, bounds);
      if (!target) return;
      const { painted } = paintHeat(
        target.data,
        grid.shape.hsCols,
        grid.shape.hsRows,
        species.map((s) => grid.hotspot(frameIndex, s)),
        lut,
      );
      target.commit();
      target.setShow(true);
      shown = { grid, frame: frameIndex, species, bounds };
      drawnKey = key;
      stats.count = painted;
      stats.frame = frameIndex;
      stats.updatedAt = ctx.now();
      ctx.requestRender();
    },
    stats: () => ({ ...stats }),
    pickAt(lon, lat) {
      if (!shown || !enabled) return null;
      const { grid, frame, species, bounds } = shown;
      const cell = cellAt(bounds, grid.shape.hsCols, grid.shape.hsRows, lon, lat);
      if (!cell) return null;
      const index = cell[1] * grid.shape.hsCols + cell[0];
      let best = -1;
      let bestValue = 0;
      for (const s of species) {
        const v = grid.hotspot(frame, s)[index]!;
        if (v > bestValue) {
          bestValue = v;
          best = s;
        }
      }
      // A cell under the display floor is clear on screen, so it is not something anyone clicked.
      if (best < 0 || lut[bestValue * 4 + 3] === 0) return null;
      const meta = ctx.meta();
      if (!meta) return null;
      const id = hotspotEvidenceId(best, lon, lat, frameStartMs(frame, meta.frame0UnixMs, stepMsOf(meta)));
      lastPick = id ? { id, species: best, score: Math.min(1, Math.max(0, bestValue * grid.hotspotScale)) } : null;
      return id;
    },
    describe(id) {
      return enabled && lastPick?.id === id ? { kind: "hotspot", species: lastPick.species, score: lastPick.score } : null;
    },
    destroy() {
      surface?.destroy();
      surface = null;
      viewer = null;
      shown = null;
      enabled = stats.enabled = false;
    },
  };
}
