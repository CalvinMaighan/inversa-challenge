"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { get } from "@calvinjs/active-state";

import { getGlobe } from "client/globe/api";
import { anchorOf, type HoverFacts } from "client/globe/hover";
import { TIME, type TimeState } from "client/state/time";
import styled from "client/styled";

import { loadEvidence } from "../drawer/evidence";
import { GLASS_CSS } from "../primitives";
import { placeTooltip, tooltipLine, tooltipText, type SightingRecordHint, type TooltipText } from "./model";

/** Dwell on one sighting before asking the evidence cache for its source and exact time. */
const ENRICH_DWELL_MS = 250;

const Box = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  z-index: 7;
  max-width: min(360px, calc(100% - 16px));
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  ${GLASS_CSS}
  color: var(--text);
  font: 400 12px / 1.35 var(--font-ui);
  pointer-events: none;
  white-space: normal;
  overflow-wrap: anywhere;

  b {
    font-weight: 650;
  }
  span {
    color: var(--muted);
  }
`;

type Shown = { id: string; text: TooltipText };

/**
 * Globe hover tooltip (T40): what the marker under the pointer is and its key value. The pick runs at most
 * once per animation frame; markers with a place pin the box to the marker, areas (alerts, hotspot cells)
 * follow the pointer. Clicking still opens the evidence drawer (the globe's own click handler).
 */
export default function GlobeTooltip() {
  const [shown, setShown] = useState<Shown | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Shown | null>(null);
  const positionRef = useRef<() => void>(() => {});

  useEffect(() => {
    let frame = 0;
    let pointer: { x: number; y: number; canvas: HTMLCanvasElement } | null = null;
    let facts: HoverFacts | null = null;
    let dwell: ReturnType<typeof setTimeout> | null = null;
    let enrichFor: string | null = null;

    const show = (next: Shown | null) => {
      shownRef.current = next;
      setShown(next);
    };
    const hide = () => {
      pointer = null;
      facts = null;
      if (dwell) clearTimeout(dwell);
      dwell = null;
      enrichFor = null;
      if (shownRef.current) show(null);
    };
    const cursorMs = () => {
      const t = { ...TIME.defaults, ...get<TimeState>(TIME) };
      const at = Date.parse(t.at ?? t.to);
      return Number.isFinite(at) ? at : Date.now();
    };

    const position = () => {
      const box = boxRef.current;
      const globe = getGlobe();
      if (!box || !pointer || !globe) return;
      const anchorGeo = facts ? anchorOf(facts) : null;
      const anchor = (anchorGeo && globe.project(anchorGeo.lon, anchorGeo.lat)) || { x: pointer.x, y: pointer.y };
      const at = placeTooltip(anchor, { width: box.offsetWidth, height: box.offsetHeight }, { width: pointer.canvas.clientWidth, height: pointer.canvas.clientHeight });
      box.style.transform = `translate(${at.x}px, ${at.y}px)`;
    };
    positionRef.current = position;

    const enrich = (id: string, f: HoverFacts) => {
      if (f.kind !== "sighting" || enrichFor === id) return;
      enrichFor = id;
      if (dwell) clearTimeout(dwell);
      dwell = setTimeout(() => {
        loadEvidence(id)
          .then((evidence) => {
            if (shownRef.current?.id !== id || !facts) return;
            show({ id, text: tooltipText(facts, cursorMs(), evidence.record as SightingRecordHint) });
          })
          .catch(() => {
            // The layer's own facts already show; the drawer reports load errors on click.
          });
      }, ENRICH_DWELL_MS);
    };

    const solve = () => {
      frame = 0;
      const globe = getGlobe();
      if (!pointer || !globe) return;
      const id = globe.pick(pointer.x, pointer.y);
      const next = id ? (globe.describe?.(id) ?? null) : null;
      if (!id || !next) {
        if (shownRef.current) hide();
        return;
      }
      if (shownRef.current?.id !== id) {
        facts = next;
        show({ id, text: tooltipText(next, cursorMs()) });
        enrich(id, next);
      }
      position();
    };

    const onMove = (event: PointerEvent) => {
      const target = event.target;
      // Only the globe canvas: HUD surfaces, the column and the legend sit above it and take their own hover.
      if (!(target instanceof HTMLCanvasElement) || !target.closest("[data-globe]") || event.buttons !== 0) {
        if (shownRef.current || pointer) hide();
        return;
      }
      const rect = target.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top, canvas: target };
      if (!frame) frame = requestAnimationFrame(solve);
    };

    // Pressing (a drag or a click), zooming, or the pointer leaving the window all hide it.
    const root = document.documentElement;
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", hide, { passive: true });
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("blur", hide);
    root.addEventListener("mouseleave", hide);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", hide);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("blur", hide);
      root.removeEventListener("mouseleave", hide);
      if (frame) cancelAnimationFrame(frame);
      if (dwell) clearTimeout(dwell);
    };
  }, []);

  // The box is measured for placement once its new text is in the DOM, before the browser paints it.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !shown) return;
    positionRef.current();
    box.style.visibility = "visible";
  }, [shown]);

  if (!shown) return null;
  return (
    <Box ref={boxRef} role="tooltip" data-testid="globe-tooltip" data-evidence-id={shown.id} aria-label={tooltipLine(shown.text)} style={{ visibility: "hidden" }}>
      <b>{shown.text.title}</b>
      {shown.text.parts.map((p, i) => (
        <span key={i}> · {p}</span>
      ))}
    </Box>
  );
}
