/**
 * A time-following raster overlay (GE5): one Cesium `ImageryLayer` over a `UrlTemplateImageryProvider` that
 * reads tiles from the same-origin Axum proxy (`/v1/<app>/overlay/<id>/{z}/{x}/{y}?time=`). The timeline
 * cursor is snapped to the source's cadence (`snapOverlayTime`); when the snapped instant changes, a new
 * layer is added over the old one and the old one retires a moment later, so a scrub never shows a blank globe.
 * The layer reports the instant it shows in `stats().overlay` for the legend.
 */
import type { Credit, ImageryLayer } from "cesium";

import { activeAppId } from "client/state/app";
import { overlaySpec, overlayTileTemplate, snapOverlayTime, type CYCLONES, type OverlayId } from "shared/overlays";

import { cesium } from "../../cesium";
import type { GlobeLayer, GlobeViewer, LayerContext, LayerStats } from "../types";
import { onCarpCursor, overlayCursorMs } from "./cursor";
import { overlayOpacity, subscribeOverlayOpacity } from "./opacity";

/** The outgoing layer stays this long under the incoming one (tiles usually land within it). */
const RETIRE_MS = 700;

export type RasterOverlayId = Exclude<OverlayId, typeof CYCLONES>;

export function createOverlayRasterLayer(id: RasterOverlayId, ctx: LayerContext): GlobeLayer {
  const spec = overlaySpec(id);
  let viewer: GlobeViewer | null = null;
  let enabled = false;
  let current: ImageryLayer | null = null;
  let credit: Credit | null = null;
  let drawnKey = "";
  const retiring = new Set<ImageryLayer>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let offOpacity: (() => void) | null = null;
  let offCursor: (() => void) | null = null;
  let lastFrame = -1;
  const stats: LayerStats = { id, enabled: false, count: 0, frame: -1, updatedAt: null, error: null };

  const removeLayer = (layer: ImageryLayer | null) => {
    if (!layer || !viewer?.scene.imageryLayers) return;
    viewer.scene.imageryLayers.remove(layer, true);
  };

  const clear = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const l of retiring) removeLayer(l);
    retiring.clear();
    removeLayer(current);
    current = null;
    drawnKey = "";
    stats.count = 0;
    delete stats.overlay;
  };

  const setCredit = (on: boolean) => {
    if (!viewer?.creditDisplay) return;
    const C = cesium();
    credit ??= new C.Credit(spec.credit, true);
    if (on) viewer.creditDisplay.addStaticCredit(credit);
    else viewer.creditDisplay.removeStaticCredit(credit);
  };

  const draw = (frameIndex: number) => {
    lastFrame = frameIndex;
    if (!enabled || !viewer) return;
    stats.frame = frameIndex;
    if (!viewer.scene.imageryLayers) {
      stats.error = "imagery layers unavailable";
      return;
    }
    const app = activeAppId();
    const snapped = snapOverlayTime(spec, overlayCursorMs(ctx), Date.now());
    const key = `${app}|${snapped.shownMs}`;
    if (key === drawnKey) return;
    const C = cesium();
    const { ImageryLayer: Layer, Rectangle, UrlTemplateImageryProvider } = C;
    const provider = new UrlTemplateImageryProvider({
      url: overlayTileTemplate(app, id, snapped.shownMs),
      maximumLevel: spec.maxZoom ?? 10,
      rectangle: Rectangle.fromDegrees(spec.bbox.west, spec.bbox.south, spec.bbox.east, spec.bbox.north),
      hasAlphaChannel: true,
      enablePickFeatures: false,
    });
    provider.errorEvent.addEventListener((e: { message?: string }) => {
      stats.error = e?.message ? `tiles: ${e.message}` : "tiles failed";
    });
    const layer = new Layer(provider, { alpha: overlayOpacity() });
    viewer.scene.imageryLayers.add(layer);
    if (current) {
      const old = current;
      retiring.add(old);
      const t = setTimeout(() => {
        timers.delete(t);
        retiring.delete(old);
        removeLayer(old);
        ctx.requestRender();
      }, RETIRE_MS);
      timers.add(t);
    }
    current = layer;
    drawnKey = key;
    stats.error = null;
    stats.count = 1;
    stats.updatedAt = ctx.now();
    stats.overlay = { shownMs: snapped.shownMs, clamped: snapped.clamped, opacity: overlayOpacity() };
    ctx.requestRender();
  };

  return {
    id,
    init(v) {
      viewer = v;
      offOpacity = subscribeOverlayOpacity(() => {
        const alpha = overlayOpacity();
        if (current) current.alpha = alpha;
        if (stats.overlay) stats.overlay = { ...stats.overlay, opacity: alpha };
        ctx.requestRender();
      });
      // Carp's "what we knew" cursor is not TIME: follow it too.
      offCursor = onCarpCursor(() => draw(lastFrame));
    },
    enable() {
      enabled = stats.enabled = true;
      setCredit(true);
    },
    disable() {
      enabled = stats.enabled = false;
      setCredit(false);
      if (current || retiring.size) {
        clear();
        ctx.requestRender();
      }
    },
    update(frameIndex) {
      draw(frameIndex);
    },
    stats: () => ({ ...stats }),
    destroy() {
      offOpacity?.();
      offOpacity = null;
      offCursor?.();
      offCursor = null;
      setCredit(false);
      clear();
      viewer = null;
      enabled = stats.enabled = false;
    },
  };
}
