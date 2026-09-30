/**
 * LST and SST rasters from the i16 environment grid (C4: 0.05°, 68 × 64, centi-°C, -32768 missing). Same
 * ground-rectangle technique as the heatmap, upscaled 4× so a gap can carry a subtle diagonal hatch. Cells
 * never valid in the resident window (land for SST, open water for LST) stay clear instead of hatched.
 */
import type { FrameGrid } from "@calvinjs/active-state/threads";

import type { LayerId } from "client/state/layers";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { boundsKey, gridBounds } from "../geometry";
import { ENV_UPSCALE, everValidMask, LST_RANGE_C, paintEnv, SST_RANGE_C, tempLut } from "../ramp";
import { createRasterSurface, type RasterSurface } from "./raster-surface";
import { RASTER_PICK_PREFIX, type GlobeLayer, type GlobeViewer, type LayerContext, type LayerStats } from "./types";

const [, , LST, SST] = LAYER_IDS;

/** The gap mask scans every resident frame; while the db worker is still filling, rescan at most this often. */
const MASK_RESCAN_MS = 2_000;

function createEnvLayer(id: LayerId, ctx: LayerContext, read: (grid: FrameGrid, frame: number) => Int16Array, range: { min: number; max: number }): GlobeLayer {
  const lut = tempLut();
  let viewer: GlobeViewer | null = null;
  let surface: RasterSurface | null = null;
  let surfaceKey = "";
  let enabled = false;
  let drawnKey = "";
  let mask: { grid: FrameGrid; version: number; at: number; cells: Uint8Array } | null = null;
  const stats: LayerStats = { id, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const everValid = (grid: FrameGrid): Uint8Array => {
    const version = grid.version();
    const now = ctx.now();
    const stale = !mask || mask.grid !== grid || (mask.version !== version && now - mask.at >= MASK_RESCAN_MS);
    if (stale) {
      const frames = function* () {
        for (let f = 0; f < grid.shape.frameCount; f += 1) yield read(grid, f);
      };
      mask = { grid, version, at: now, cells: everValidMask(frames(), grid.layout.envCells) };
    }
    return mask!.cells;
  };

  const hide = () => {
    surface?.setShow(false);
    drawnKey = "";
    stats.count = 0;
  };

  return {
    id,
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
      if (!enabled || !viewer) return;
      if (!grid || frameIndex < 0 || frameIndex >= grid.shape.frameCount || grid.layout.envCells === 0) {
        if (drawnKey) {
          hide();
          ctx.requestRender();
        }
        return;
      }
      const { envCols, envRows } = grid.shape;
      const bounds = gridBounds(grid.shape, ctx.timeline()?.geometry).env;
      const key = `${frameIndex}|${grid.version()}|${grid.buffer.byteLength}|${boundsKey(bounds)}`;
      if (key === drawnKey) return;
      const sizeKey = `${envCols}x${envRows}@${boundsKey(bounds)}`;
      if (!surface || surfaceKey !== sizeKey) {
        surface?.destroy();
        surface = createRasterSurface(viewer, {
          pickId: `${RASTER_PICK_PREFIX}${id}`,
          bbox: bounds,
          width: envCols * ENV_UPSCALE,
          height: envRows * ENV_UPSCALE,
          sampling: "nearest",
        });
        surfaceKey = sizeKey;
      }
      const { valid } = paintEnv(surface.data, envCols, envRows, read(grid, frameIndex), lut, range, ENV_UPSCALE, everValid(grid));
      surface.commit();
      surface.setShow(true);
      drawnKey = key;
      stats.count = valid;
      stats.frame = frameIndex;
      stats.updatedAt = ctx.now();
      ctx.requestRender();
    },
    stats: () => ({ ...stats }),
    destroy() {
      surface?.destroy();
      surface = null;
      viewer = null;
      mask = null;
      enabled = stats.enabled = false;
    },
  };
}

export function createLstLayer(ctx: LayerContext): GlobeLayer {
  return createEnvLayer(LST, ctx, (grid, frame) => grid.lst(frame), LST_RANGE_C);
}

export function createSstLayer(ctx: LayerContext): GlobeLayer {
  return createEnvLayer(SST, ctx, (grid, frame) => grid.sst(frame), SST_RANGE_C);
}
