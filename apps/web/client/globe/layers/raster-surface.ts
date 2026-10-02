/**
 * A canvas-textured ground rectangle over the region, repainted in place. The heatmap and the LST/SST rasters
 * paint straight into `data` (an ImageData buffer) and `commit()`.
 *
 * Cesium's Image material re-uploads its texture only when the uniform changes identity, so two canvases take
 * turns: commit paints the back canvas and swaps it in. One small texture upload per frame change, no new
 * primitive, no imagery-layer reload.
 */
import type { BBox } from "shared/agent/events";

import { cesium } from "../cesium";
import type { GlobeViewer } from "./types";

export type RasterSurface = {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major from the top (north). */
  readonly data: Uint8ClampedArray;
  commit(): void;
  setShow(show: boolean): void;
  destroy(): void;
};

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Samples texel centres only. Linear filtering between a coloured texel and a transparent one (whose RGB the
 * canvas stores as black) draws a dark fringe along every domain edge (the coastline, for SST); snapping to
 * texel centres shows each cell as the flat square it is.
 */
const NEAREST_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec4 c = texture(image, (floor(materialInput.st * size) + 0.5) / size);
  material.diffuse = c.rgb;
  material.alpha = c.a;
  return material;
}`;

export function createRasterSurface(
  viewer: GlobeViewer,
  opts: { pickId: string; bbox: Readonly<BBox>; width: number; height: number; sampling?: "linear" | "nearest" },
): RasterSurface {
  const { Cartesian2, ClassificationType, GeometryInstance, GroundPrimitive, Material, MaterialAppearance, Rectangle, RectangleGeometry } = cesium();
  const { width, height } = opts;
  const canvases = [createCanvas(width, height), createCanvas(width, height)];
  const contexts = canvases.map((c) => {
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("raster surface: 2D canvas unavailable");
    return ctx;
  });
  const image = contexts[0]!.createImageData(width, height);
  let front = 0;

  const material =
    opts.sampling === "nearest"
      ? new Material({
          fabric: { uniforms: { image: canvases[front], size: new Cartesian2(width, height) }, source: NEAREST_SOURCE },
          translucent: true,
        })
      : Material.fromType("Image", { image: canvases[front] });
  const primitive = new GroundPrimitive({
    geometryInstances: new GeometryInstance({
      id: opts.pickId,
      geometry: new RectangleGeometry({
        rectangle: Rectangle.fromDegrees(opts.bbox.west, opts.bbox.south, opts.bbox.east, opts.bbox.north),
      }),
    }),
    appearance: new MaterialAppearance({ material, flat: true, translucent: true }),
    classificationType: ClassificationType.BOTH,
    show: false,
  });
  viewer.scene.primitives.add(primitive);
  let destroyed = false;

  return {
    width,
    height,
    data: image.data,
    commit() {
      if (destroyed) return;
      const back = 1 - front;
      contexts[back]!.putImageData(image, 0, 0);
      material.uniforms.image = canvases[back];
      front = back;
    },
    setShow(show) {
      if (!destroyed) primitive.show = show;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      viewer.scene.primitives.remove(primitive);
    },
  };
}
