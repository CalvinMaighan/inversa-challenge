"use client";

import { useCallback, useEffect, useRef } from "react";

import { getGlobe, onGlobeReady, type GlobeApi, type ScreenPoint } from "client/globe/api";
import styled from "client/styled";

import { CELL_DEG, cellCenter, parseHotspotId } from "../drawer/evidence";
import { openEvidence } from "../selection";
import { acquireAlpha, bracketSegments, monoWidth } from "./brackets";
import { LabelArbiter, type LabelCandidate, type Rect } from "./label-arbiter";
import { useTargets, type Target } from "./targets";

/** Label metrics: 11 px JetBrains Mono advances about 6.6 px per glyph. */
const LABEL_ADVANCE = 6.6;
const LABEL_PAD = 6;
const LABEL_HEIGHT = 18;
const BRACKET_SELECTED = 16;
const BRACKET_CITED = 11;
const FADE_MS = 180;
/** Scope-mask keyhole radius as a share of the shorter viewport side, and the dim outside it. */
const SCOPE_RADIUS = 0.28;
const SCOPE_FEATHER = 0.18;
const SCOPE_DIM = 0.62;

const Layer = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
`;

const Labels = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
`;

const LabelButton = styled.button<{ $selected: boolean }>`
  position: absolute;
  top: 0;
  left: 0;
  height: ${LABEL_HEIGHT}px;
  padding: 0 ${LABEL_PAD}px;
  border: 1px solid ${(p) => (p.$selected ? "var(--accent)" : "var(--hud-line)")};
  border-radius: 3px;
  background: color-mix(in oklch, var(--bg) 78%, transparent);
  color: var(--text);
  font: 600 11px / ${LABEL_HEIGHT - 2}px var(--font-mono);
  white-space: nowrap;
  cursor: pointer;
  visibility: hidden;
  pointer-events: auto;
  will-change: transform;
  &:hover,
  &:focus-visible {
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 25%, var(--bg));
  }
`;

type Colors = { selected: string; cited: string; highlight: string };

function readColors(el: Element): Colors {
  const s = getComputedStyle(el);
  return {
    selected: s.getPropertyValue("--accent").trim() || "#d34b4d",
    cited: s.getPropertyValue("--hud-line").trim() || "#aaa",
    highlight: s.getPropertyValue("--warn").trim() || "#c89b3c",
  };
}

/** Agent-highlighted entities (PLAN.md C17) bracket smaller; the hovered one pulses. */
const BRACKET_HIGHLIGHT = 9;
const PULSE_MS = 900;

/** Outline of a hotspot cell (0.01° square), projected corner by corner, or null when a corner is off screen. */
function cellOutline(globe: GlobeApi, id: string): ScreenPoint[] | null {
  const ref = parseHotspotId(id);
  if (!ref) return null;
  const c = cellCenter(ref.col, ref.row);
  const h = CELL_DEG / 2;
  const corners = [
    [c.lon - h, c.lat - h],
    [c.lon + h, c.lat - h],
    [c.lon + h, c.lat + h],
    [c.lon - h, c.lat + h],
  ].map(([lon, lat]) => globe.project(lon!, lat!));
  return corners.every((p): p is ScreenPoint => p !== null) ? corners : null;
}

function sizeCanvas(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): CanvasRenderingContext2D | null {
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * Scope mask (after God's Eye View `scopeMask.js`): dims everything outside a feathered circle around the
 * selection, or the screen centre when the selection is off screen.
 */
function drawScope(ctx: CanvasRenderingContext2D, w: number, h: number, center: ScreenPoint | null): { x: number; y: number; r: number } {
  const cx = center?.x ?? w / 2;
  const cy = center?.y ?? h / 2;
  const r = Math.min(w, h) * SCOPE_RADIUS;
  const inner = r * (1 - SCOPE_FEATHER / 2);
  const outer = r * (1 + SCOPE_FEATHER / 2);
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${SCOPE_DIM})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return { x: cx, y: cy, r };
}

/**
 * Detection brackets and arbitrated labels over cited and selected entities, redrawn after each globe frame
 * (PLAN.md C16 `onPostRender`) so they track the camera. Brackets and the scope mask are canvas; labels are
 * buttons (clickable, focusable) moved with transforms, so tracking never re-renders React.
 */
export default function DetectionOverlay({ focus, layout }: { focus: boolean; layout: string }) {
  const targets = useTargets();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelEls = useRef(new Map<string, HTMLButtonElement>());
  const live = useRef<{ targets: Target[]; focus: boolean }>({ targets: [], focus: false });
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const arbiter = new LabelArbiter({ padding: 4, gap: 5 });
    const firstSeen = new Map<string, number>();
    let api: GlobeApi | null = null;
    let offRender = () => {};

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const ctx = sizeCanvas(canvas, w, h, Math.min(2, window.devicePixelRatio || 1));
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const globe = api && getGlobe() === api ? api : null;
      const { targets: list, focus: scoped } = live.current;
      const colors = readColors(canvas);
      const now = performance.now();
      const candidates: LabelCandidate[] = [];
      let selectedPoint: ScreenPoint | null = null;
      let fading = false;
      let drawn = 0;
      let drawnHighlight = 0;

      for (const t of list) {
        const p = globe ? globe.project(t.lon, t.lat) : null;
        if (!p || p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) continue;
        if (t.selected) selectedPoint = p;
        if (!firstSeen.has(t.id)) firstSeen.set(t.id, now);
        const alpha = acquireAlpha(firstSeen.get(t.id)!, now, FADE_MS);
        if (alpha < 1) fading = true;
        const agent = !t.selected && !t.cited;
        // A hovered panel row breathes: the bracket swells and shrinks until the pointer leaves.
        const pulse = t.hovered ? 1 + 0.45 * (0.5 + 0.5 * Math.sin((now / PULSE_MS) * Math.PI * 2)) : 1;
        if (t.hovered) fading = true;
        const half = (t.selected ? BRACKET_SELECTED : agent ? BRACKET_HIGHLIGHT : BRACKET_CITED) * pulse;
        const color = t.selected ? colors.selected : agent ? colors.highlight : colors.cited;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = t.selected || t.hovered ? 2 : agent ? 1.25 : 1.5;
        const outline = t.kind === "hotspot" && globe ? cellOutline(globe, t.id) : null;
        if (outline) {
          // Hotspot cells are areas: outline the 0.01° square as well as bracketing its centre.
          ctx.beginPath();
          outline.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.closePath();
          ctx.stroke();
        }
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of bracketSegments(p.x, p.y, half * (2 - alpha), half * 0.45)) {
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
        drawn += 1;
        if (t.highlight) drawnHighlight += 1;
        if (t.selected) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = colors.selected;
          ctx.fill();
        }
        candidates.push({ key: t.id, x: p.x, y: p.y, w: monoWidth(t.label, LABEL_ADVANCE, LABEL_PAD) + 2, h: LABEL_HEIGHT, bracket: half, priority: t.priority });
      }
      ctx.globalAlpha = 1;
      for (const id of [...firstSeen.keys()]) if (!list.some((t) => t.id === id)) firstSeen.delete(id);
      // Counts for tests and the e2e: brackets on screen, and how many of them are the agent's highlight.
      canvas.dataset.brackets = String(drawn);
      canvas.dataset.highlightBrackets = String(drawnHighlight);
      canvas.dataset.highlightTargets = String(list.filter((t) => t.highlight).length);

      const scope = scoped ? drawScope(ctx, w, h, selectedPoint) : null;

      // HUD surfaces are obstacles too: a label under the drawer or the timeline is a label nobody sees.
      const obstacles: Rect[] = [];
      for (const el of document.querySelectorAll("[data-hud-obstacle]")) {
        const r = el.getBoundingClientRect();
        obstacles.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
      const placed = new Map(arbiter.solve(candidates, w, h, obstacles).map((p) => [p.key, p]));
      for (const [id, el] of labelEls.current) {
        const p = placed.get(id);
        if (!p) {
          el.style.visibility = "hidden";
          continue;
        }
        el.style.visibility = "visible";
        el.style.transform = `translate(${Math.round(p.rect.x)}px, ${Math.round(p.rect.y)}px)`;
        // Labels sit above the mask canvas, so the scope dims them itself.
        const outside = scope && Math.hypot(p.rect.x + p.rect.w / 2 - scope.x, p.rect.y + p.rect.h / 2 - scope.y) > scope.r;
        el.style.opacity = outside ? String(1 - SCOPE_DIM) : "";
        el.dataset.corner = p.corner;
      }
      if (fading) globe?.requestRender();
    };
    drawRef.current = draw;

    const offReady = onGlobeReady((g) => {
      offRender();
      api = g;
      offRender = g.onPostRender(draw);
      g.requestRender();
    });
    const onResize = () => (api ? api.requestRender() : draw());
    window.addEventListener("resize", onResize);
    draw();
    return () => {
      offReady();
      offRender();
      window.removeEventListener("resize", onResize);
      drawRef.current = () => {};
    };
  }, []);

  // `layout` changes when a panel opens or closes: the label obstacles moved, so labels are placed again.
  useEffect(() => {
    live.current = { targets, focus };
    const globe = getGlobe();
    if (globe) globe.requestRender();
    else drawRef.current();
  }, [targets, focus, layout]);

  const register = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) labelEls.current.set(id, el);
    else labelEls.current.delete(id);
  }, []);

  return (
    <>
      <Layer ref={canvasRef} aria-hidden="true" data-testid="hud-overlay" />
      <Labels data-testid="hud-labels">
        {targets.map((t) => (
          <LabelButton
            key={t.id}
            ref={(el) => register(t.id, el)}
            type="button"
            $selected={t.selected}
            data-evidence={t.id}
            onClick={() => openEvidence(t.id)}
            title={`Open evidence ${t.id}`}
          >
            {t.label}
          </LabelButton>
        ))}
      </Labels>
    </>
  );
}
