"use client";

import { useEffect, useRef } from "react";
import { get, set, subscribe } from "@calvinjs/active-state";
import type { FrameGrid } from "@calvinjs/active-state/threads";

import { ENV_MISSING } from "shared/frames";

import { registerGlobe, type GlobeApi } from "client/globe/api";
import { TIME, type TimeState } from "client/state/time";
import { REGION_BBOX, VIEW, type ViewState } from "client/state/view";
import styled from "client/styled";

import { frameIndexAt } from "../timeline/frames";
import { isLand } from "./fixture";

const Canvas = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  background: #0b1418;
`;

/** Species tints for the heat layer, in EVF_SPECIES order. */
const TINTS: [number, number, number][] = [
  [255, 96, 64],
  [255, 200, 64],
  [96, 220, 120],
  [96, 170, 255],
];

/** Equirectangular fit of the region into the viewport, x scaled by cos(mid-latitude). */
function fit(w: number, h: number) {
  const b = REGION_BBOX;
  const k = Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);
  const spanX = (b.east - b.west) * k;
  const spanY = b.north - b.south;
  const scale = Math.min(w / spanX, h / spanY) * 0.92;
  const ox = (w - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;
  return {
    toScreen: (lon: number, lat: number) => ({ x: ox + (lon - b.west) * k * scale, y: oy + (b.north - lat) * scale }),
    rect: { x: ox, y: oy, w: spanX * scale, h: spanY * scale },
  };
}

/**
 * Stand-in globe for the HUD dev route: a flat map of the region that renders the current frame straight from
 * the SAB frame grid (hotspot heat, cloud-masked cells hatched) and registers a `GlobeApi` (PLAN.md C16), so
 * the HUD's brackets, cursor readout and scope mask run exactly as over Cesium. Like Cesium in
 * `requestRenderMode`, it renders on the next animation frame after a TIME change and then fires post-render.
 */
export default function FixtureGlobe({ grid }: { grid: FrameGrid }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { hsCols, hsRows, envCols, envRows, speciesCount, frameCount } = grid.shape;
    const heat = new ImageData(hsCols, hsRows);
    const heatCanvas = document.createElement("canvas");
    heatCanvas.width = hsCols;
    heatCanvas.height = hsRows;
    const heatCtx = heatCanvas.getContext("2d")!;
    const cloud = new ImageData(envCols, envRows);
    const cloudCanvas = document.createElement("canvas");
    cloudCanvas.width = envCols;
    cloudCanvas.height = envRows;
    const cloudCtx = cloudCanvas.getContext("2d")!;
    const base = document.createElement("canvas");
    base.width = envCols * 4;
    base.height = envRows * 4;
    const baseImage = new ImageData(base.width, base.height);
    for (let r = 0; r < base.height; r++) {
      for (let c = 0; c < base.width; c++) {
        const lon = REGION_BBOX.west + ((c + 0.5) / base.width) * (REGION_BBOX.east - REGION_BBOX.west);
        const lat = REGION_BBOX.north - ((r + 0.5) / base.height) * (REGION_BBOX.north - REGION_BBOX.south);
        const [red, green, blue] = isLand(lon, lat) ? [29, 43, 34] : [15, 34, 48];
        const o = (r * base.width + c) * 4;
        baseImage.data.set([red, green, blue, 255], o);
      }
    }
    base.getContext("2d")!.putImageData(baseImage, 0, 0);

    const listeners = new Set<() => void>();
    let pending = 0;
    let w = 0;
    let h = 0;
    let view = fit(1, 1);

    const render = () => {
      pending = 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      view = fit(w, h);
      const time = get<TimeState>(TIME) ?? TIME.defaults;
      const frame = frameIndexAt(Date.parse(time.at ?? time.to), Date.parse(time.from), Date.parse(time.to), frameCount);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { rect } = view;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(base, rect.x, rect.y, rect.w, rect.h);
      if (frame >= 0) {
        // Heat: strongest species per cell, rows flipped (grid rows run south to north).
        const px = heat.data;
        const planes = Array.from({ length: speciesCount }, (_, s) => grid.hotspot(frame, s));
        for (let r = 0; r < hsRows; r++) {
          const dst = (hsRows - 1 - r) * hsCols;
          for (let c = 0; c < hsCols; c++) {
            const i = r * hsCols + c;
            let best = 0;
            let bestS = 0;
            for (let s = 0; s < speciesCount; s++) {
              const v = planes[s]![i]!;
              if (v > best) {
                best = v;
                bestS = s;
              }
            }
            const o = (dst + c) * 4;
            const tint = TINTS[bestS % TINTS.length]!;
            px[o] = tint[0];
            px[o + 1] = tint[1];
            px[o + 2] = tint[2];
            px[o + 3] = best < 20 ? 0 : Math.min(230, best);
          }
        }
        heatCtx.putImageData(heat, 0, 0);
        ctx.drawImage(heatCanvas, rect.x, rect.y, rect.w, rect.h);

        // Cloud-masked cells: missing where the cell is ever valid (land LST, water SST), drawn grey.
        const lst = grid.lst(frame);
        const sst = grid.sst(frame);
        const cp = cloud.data;
        for (let r = 0; r < envRows; r++) {
          const dst = (envRows - 1 - r) * envCols;
          for (let c = 0; c < envCols; c++) {
            const i = r * envCols + c;
            const o = (dst + c) * 4;
            const missing = lst[i] === ENV_MISSING && sst[i] === ENV_MISSING;
            cp[o] = 200;
            cp[o + 1] = 205;
            cp[o + 2] = 210;
            cp[o + 3] = missing ? 120 : 0;
          }
        }
        cloudCtx.putImageData(cloud, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cloudCanvas, rect.x, rect.y, rect.w, rect.h);
      }
      ctx.strokeStyle = "rgba(160, 220, 180, 0.35)";
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
      // Which frame is on screen, for the scrub e2e to check against the scrubber.
      canvas.dataset.frame = String(frame);
      for (const cb of listeners) cb();
    };
    const requestRender = () => {
      if (!pending) pending = requestAnimationFrame(render);
    };

    const api: GlobeApi = {
      flyTo(target) {
        set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, lon: target.lon, lat: target.lat }));
        requestRender();
      },
      project(lon, lat) {
        const p = view.toScreen(lon, lat);
        return p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h ? p : null;
      },
      pick() {
        return null;
      },
      onPostRender(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      requestRender,
    };
    render();
    registerGlobe(api);
    const offTime = subscribe(TIME, requestRender);
    window.addEventListener("resize", requestRender);
    return () => {
      offTime();
      window.removeEventListener("resize", requestRender);
      if (pending) cancelAnimationFrame(pending);
      registerGlobe(null);
    };
  }, [grid]);

  return <Canvas ref={ref} data-testid="fixture-globe" />;
}
