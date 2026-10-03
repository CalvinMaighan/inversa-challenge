"use client";

import { useEffect, useRef } from "react";

import { getGlobe, onGlobeReady } from "client/globe/api";
import { STAGE_SCOPE_CSS } from "client/hud/shell/StageShell";
import { imageGlyphSvg } from "client/media/glyph";
import styled from "client/styled";

import { loadFish, selectFish, speciesColor, useFish, type CarpSighting } from "./fish";

const RADIUS = 4.5;
/** How close (CSS px) a pointer must be to a dot to hover or click it. */
const HIT_PX = 9;
/** A press that moves farther than this is a drag of the globe, not a click on a dot. */
const CLICK_SLOP_PX = 5;
const SOURCE_NAMES = { inat: "iNaturalist", gbif: "GBIF", nas: "USGS NAS" } as const;

const Layer = styled.div`
  position: absolute;
  /* Canvas pixels: the HUD chrome this sits in starts right of the chat card (--chat-inset), the globe at 0. */
  inset: 0 0 0 calc(-1 * var(--chat-inset, 0px));
  ${STAGE_SCOPE_CSS}
  overflow: hidden;
  z-index: 1;
  && {
    pointer-events: none;
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* The selected sighting: a disc in its species' colour that pulses outward, as on the Inversa site. */
  .pulse {
    position: absolute;
    left: 0;
    top: 0;
    width: 9px;
    height: 9px;
    margin: -4.5px 0 0 -4.5px;
    border-radius: 50%;
    background: var(--dot);
    @keyframes dot-pulse {
      from {
        transform: scale(1);
        opacity: 0.6;
      }
      to {
        transform: scale(4.2);
        opacity: 0;
      }
    }
    animation: dot-pulse 1.6s ease-out infinite;
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  }
  .pos {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform;
  }
  .pos[data-hidden] {
    visibility: hidden;
  }

  .tip {
    position: absolute;
    transform: translate(-50%, calc(-100% - 10px));
    width: max-content;
    max-width: 240px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: color-mix(in oklch, var(--surface) 82%, transparent);
    backdrop-filter: blur(10px) saturate(1.2);
    -webkit-backdrop-filter: blur(10px) saturate(1.2);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 400 12px / 1.4 var(--font-ui);
    pointer-events: none;
    z-index: 2;
  }
  .tip[data-hidden] {
    visibility: hidden;
  }
  .tip b {
    display: block;
    font-weight: 600;
  }
  .tip small {
    display: block;
    color: var(--muted);
  }
  .tip .img {
    display: inline-block;
    margin-left: 6px;
    vertical-align: -2px;
    color: var(--muted);
  }
`;

type Dot = { id: string; x: number; y: number };

/**
 * The Asian carp sightings on the carp map: one canvas, a dot per record in its species' colour, redrawn after every globe
 * frame. Thousands of records cost one draw call each frame instead of thousands of DOM elements; hover, click and the
 * selected sighting's pulse are handled from the dots' screen positions. Hidden behind the globe and when the chip is off.
 */
export default function FishMarkers() {
  const { shown, visible, selectedId } = useFish();
  const layerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(shown);
  const selectedRef = useRef(selectedId);
  const dots = useRef<Dot[]>([]);
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    shownRef.current = shown;
    selectedRef.current = selectedId;
    getGlobe()?.requestRender();
    redraw.current();
  }, [shown, selectedId]);

  useEffect(() => {
    loadFish();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const layer = layerRef.current;
    const canvas = canvasRef.current;
    if (!layer || !canvas) return;
    let off = () => {};
    const size = { w: 0, h: 0, dpr: 1 };
    const fit = () => {
      const r = layer.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.w = r.width;
      size.h = r.height;
      size.dpr = dpr;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      redraw.current();
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(layer);
    fit();

    const stopReady = onGlobeReady((api) => {
      off();
      const draw = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
        ctx.clearRect(0, 0, size.w, size.h);
        const next: Dot[] = [];
        const selected = selectedRef.current;
        let selectedAt: { x: number; y: number; s: CarpSighting } | null = null;
        for (const s of shownRef.current) {
          const p = api.project(s.lon, s.lat);
          if (!p || p.x < -RADIUS || p.y < -RADIUS || p.x > size.w + RADIUS || p.y > size.h + RADIUS) continue;
          next.push({ id: s.id, x: p.x, y: p.y });
          if (s.id === selected) {
            selectedAt = { x: p.x, y: p.y, s };
            continue;
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = speciesColor(s.species);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.stroke();
        }
        dots.current = next;
        const pulse = pulseRef.current;
        if (selectedAt) {
          // The selected dot is drawn last, ringed in a halo.
          ctx.beginPath();
          ctx.arc(selectedAt.x, selectedAt.y, RADIUS + 3.5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,255,255,0.28)";
          ctx.fill();
          ctx.beginPath();
          ctx.arc(selectedAt.x, selectedAt.y, RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = speciesColor(selectedAt.s.species);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.stroke();
          if (pulse) {
            pulse.removeAttribute("data-hidden");
            pulse.style.transform = `translate(${Math.round(selectedAt.x)}px, ${Math.round(selectedAt.y)}px)`;
            pulse.style.setProperty("--dot", speciesColor(selectedAt.s.species));
          }
        } else pulse?.setAttribute("data-hidden", "");
      };
      redraw.current = draw;
      off = api.onPostRender(draw);
      draw();
      api.requestRender();
    });

    // Hover and click come from the globe's own surface (the layer lets the pointer through, so dragging and the
    // wheel reach the camera untouched).
    const surface = document.querySelector<HTMLElement>('[data-slot="globe"]');
    let down: { x: number; y: number } | null = null;
    let frame = 0;
    const nearest = (clientX: number, clientY: number): { dot: Dot; s: CarpSighting } | null => {
      const r = layer.getBoundingClientRect();
      const x = clientX - r.left;
      const y = clientY - r.top;
      let best: Dot | null = null;
      let bestD = HIT_PX * HIT_PX;
      for (const d of dots.current) {
        const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
        if (dd <= bestD) {
          best = d;
          bestD = dd;
        }
      }
      const s = best ? shownRef.current.find((f) => f.id === best.id) : undefined;
      return best && s ? { dot: best, s } : null;
    };
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      const { clientX, clientY } = e;
      frame = requestAnimationFrame(() => {
        const hit = nearest(clientX, clientY);
        const tip = tipRef.current;
        if (surface) surface.style.cursor = hit ? "pointer" : "";
        if (!tip) return;
        if (!hit) {
          tip.setAttribute("data-hidden", "");
          return;
        }
        tip.innerHTML = "";
        const b = document.createElement("b");
        b.textContent = hit.s.species;
        const small = document.createElement("small");
        small.textContent = SOURCE_NAMES[hit.s.source];
        if (hit.s.photo) {
          const img = document.createElement("span");
          img.className = "img";
          img.title = "Has a photo";
          img.innerHTML = imageGlyphSvg();
          b.append(img);
        }
        tip.append(b, hit.s.date ?? "Date unknown", small);
        tip.style.left = `${hit.dot.x}px`;
        tip.style.top = `${hit.dot.y}px`;
        tip.removeAttribute("data-hidden");
      });
    };
    const onLeave = () => {
      tipRef.current?.setAttribute("data-hidden", "");
      if (surface) surface.style.cursor = "";
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
      const hit = nearest(e.clientX, e.clientY);
      if (hit) selectFish(hit.s.id);
    };
    surface?.addEventListener("pointermove", onMove);
    surface?.addEventListener("pointerleave", onLeave);
    surface?.addEventListener("pointerdown", onDown);
    surface?.addEventListener("pointerup", onUp);
    return () => {
      cancelAnimationFrame(frame);
      stopReady();
      off();
      ro?.disconnect();
      redraw.current = () => {};
      surface?.removeEventListener("pointermove", onMove);
      surface?.removeEventListener("pointerleave", onLeave);
      surface?.removeEventListener("pointerdown", onDown);
      surface?.removeEventListener("pointerup", onUp);
      if (surface) surface.style.cursor = "";
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <Layer ref={layerRef} data-testid="carp-fish" data-count={shown.length} role="img" aria-label={`${shown.length} Asian carp sightings on the map`}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div ref={pulseRef} className="pos" data-hidden="" aria-hidden="true">
        <div className="pulse" />
      </div>
      <div ref={tipRef} className="tip" data-hidden="" role="tooltip" />
    </Layer>
  );
}
