"use client";

import { useEffect, useRef } from "react";

import { onGlobeReady } from "client/globe/api";
import styled from "client/styled";

import { drawField, drawHeat, drawHeatLabels, type HeatDrawStats } from "./draw";
import { componentText, heatAt, isCopy, isLate, isoDay, type Area, type HeatPixel, type MarinePoint, type PriorityCell, type Report } from "./model";

const Layer = styled.div`
  position: absolute;
  inset: 0;
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
`;

const Marker = styled.button`
  position: absolute;
  left: 0;
  top: 0;
  padding: 0;
  border: 0;
  cursor: pointer;
  pointer-events: auto;
  will-change: transform;
  &[data-hidden] {
    visibility: hidden;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  /* A report: one dot per record, by date basis; a GBIF copy is a hollow dashed ring, never counted. */
  &[data-kind="report"] {
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: var(--lionfish, #a06cd5);
    box-shadow: 0 0 0 1.5px #0b0d12, 0 0 6px color-mix(in oklch, #a06cd5 70%, transparent);
  }
  &[data-kind="report"][data-copy] {
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    background: transparent;
    border: 2px dashed #d9c6f2;
    box-shadow: none;
  }
  &[data-kind="report"][data-late]::after {
    content: "";
    position: absolute;
    right: -3px;
    top: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f4f1de;
    box-shadow: 0 0 0 1.5px #0b0d12;
  }

  /* A ranked survey cell: rank number in a square; thin areas dashed and labelled. */
  &[data-kind="cell"] {
    width: 26px;
    height: 26px;
    margin: -13px 0 0 -13px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    background: color-mix(in oklch, #0b0d12 70%, transparent);
    border: 2px solid #f2c14e;
    color: #fff4d6;
    font: 700 12px / 1 var(--font-mono);
  }
  &[data-kind="cell"][data-thin] {
    border-style: dashed;
    border-color: #c9c9d6;
    color: #e8e8f0;
  }
  &[data-kind="cell"][aria-pressed="true"] {
    box-shadow: 0 0 0 3px var(--accent), 0 0 14px var(--hud-glow);
  }

  .tip {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translateX(-50%);
    width: max-content;
    max-width: 260px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 400 12px / 1.4 var(--font-ui);
    text-align: left;
    visibility: hidden;
    pointer-events: none;
    z-index: 2;
  }
  .tip b {
    display: block;
    font-weight: 600;
  }
  .tip small {
    display: block;
    color: var(--muted);
  }
  &:hover .tip,
  &:focus-visible .tip {
    visibility: visible;
  }
`;

const SOURCE_NAME: Record<string, string> = { inat: "iNaturalist", gbif: "GBIF", nas: "USGS NAS" };
export const sourceName = (s: string) => SOURCE_NAME[s] ?? s;

export function reportLabel(r: Report): string {
  const parts = [
    `Lionfish report, ${sourceName(r.source)} ${r.extId}`,
    `observed ${isoDay(r.observedMs)}`,
    r.submittedMs !== null ? `submitted ${isoDay(r.submittedMs)}` : "no submitted date",
    r.quality.toLowerCase().replace("_", " "),
  ];
  if (isCopy(r)) parts.push("GBIF copy of an iNaturalist record, not counted");
  if (isLate(r)) parts.push("uploaded more than 30 days after the dive");
  return parts.join(", ");
}

export function cellLabel(c: PriorityCell, rank: number, area: string): string {
  const k = c.components;
  return `Survey priority ${rank} in ${area}${c.thin ? " (thin area, low confidence)" : ""}: recent reports ${componentText(k.recentReports)}, identification quality ${componentText(k.idQuality)}, reef heat stress ${componentText(k.heatStress)}, data completeness ${componentText(k.completeness)}`;
}

export type OverlayProps = {
  areas: readonly Area[];
  atMs: number;
  /** Reports to draw (window, basis and filters applied). */
  reports: readonly Report[] | null;
  cells: readonly { cell: PriorityCell; rank: number }[];
  heat: readonly HeatPixel[] | null;
  marine: readonly MarinePoint[] | null;
  show: { reports: boolean; heat: boolean; priority: boolean; field: boolean };
  selectedCell: string | null;
  onReport: (r: Report) => void;
  onCell: (c: PriorityCell) => void;
};

type Placed = { lat: number; lon: number };

/**
 * The lionfish layers over the globe: a canvas for CRW heat pixels and field-window glyphs (redrawn after every
 * globe frame), and buttons for reports and ranked cells (keyboard and screen readers reach them), positioned
 * over their globe points after every render and hidden behind the globe.
 */
export default function Overlay(p: OverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const refs = useRef(new Map<string, { el: HTMLButtonElement; at: Placed }>());
  const props = useRef(p);
  const redraw = useRef<() => void>(() => {});
  useEffect(() => {
    props.current = p;
    redraw.current();
  });

  useEffect(() => {
    let off = () => {};
    const stopReady = onGlobeReady((api) => {
      off();
      const place = () => {
        for (const { el, at } of refs.current.values()) {
          const pt = api.project(at.lon, at.lat);
          if (!pt) {
            el.setAttribute("data-hidden", "");
            continue;
          }
          el.removeAttribute("data-hidden");
          el.style.transform = `translate(${Math.round(pt.x)}px, ${Math.round(pt.y)}px)`;
        }
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const cur = props.current;
        const project = (lon: number, lat: number) => api.project(lon, lat);
        let stats: HeatDrawStats = { ok: 0, stale: 0, missing: 0, disagree: 0 };
        if (cur.show.heat && cur.heat) {
          stats = drawHeat(ctx, cur.heat, cur.atMs, project);
          drawHeatLabels(ctx, heatLabels(cur.areas, cur.heat, cur.atMs), project);
        }
        const field = cur.show.field && cur.marine ? drawField(ctx, cur.marine, project) : 0;
        canvas.dataset.heatOk = String(stats.ok);
        canvas.dataset.heatStale = String(stats.stale);
        canvas.dataset.heatMissing = String(stats.missing);
        canvas.dataset.field = String(field);
      };
      redraw.current = () => {
        place();
        api.requestRender();
      };
      off = api.onPostRender(place);
      redraw.current();
    });
    return () => {
      stopReady();
      off();
      redraw.current = () => {};
    };
  }, []);

  const bind = (key: string, at: Placed) => (el: HTMLButtonElement | null) => {
    if (el) refs.current.set(key, { el, at });
    else refs.current.delete(key);
  };
  const areaName = (id: string) => p.areas.find((a) => a.id === id)?.name ?? id;

  return (
    <Layer data-testid="lionfish-overlay" data-asof={p.atMs} aria-label="Lionfish layers on the map">
      <canvas ref={canvasRef} data-testid="lionfish-canvas" aria-hidden="true" />
      {p.show.reports && p.reports
        ? p.reports.map((r) => (
            <Marker
              key={`r${r.id}`}
              ref={bind(`r${r.id}`, r)}
              type="button"
              data-kind="report"
              data-report={r.id}
              data-copy={isCopy(r) ? "" : undefined}
              data-late={isLate(r) ? "" : undefined}
              data-hidden=""
              aria-label={reportLabel(r)}
              onClick={() => p.onReport(r)}
            >
              <span className="tip" role="tooltip" aria-hidden="true">
                <b>{isCopy(r) ? "GBIF copy (not counted)" : `Lionfish report · ${sourceName(r.source)}`}</b>
                Observed {isoDay(r.observedMs)}
                <small>{r.submittedMs !== null ? `Submitted ${isoDay(r.submittedMs)}` : "No submitted date at the source"}</small>
                <small>{r.quality.toLowerCase().replace("_", " ")}</small>
              </span>
            </Marker>
          ))
        : null}
      {p.show.priority
        ? p.cells.map(({ cell: c, rank }) => (
            <Marker
              key={`c${c.cell}`}
              ref={bind(`c${c.cell}`, c)}
              type="button"
              data-kind="cell"
              data-cell={c.cell}
              data-thin={c.thin ? "" : undefined}
              data-hidden=""
              aria-pressed={p.selectedCell === c.cell}
              aria-label={cellLabel(c, rank, areaName(c.regionId))}
              onClick={() => p.onCell(c)}
            >
              {rank}
              <span className="tip" role="tooltip" aria-hidden="true">
                <b>
                  Survey priority {rank} · {areaName(c.regionId)}
                </b>
                {c.thin ? "Thin area: low confidence" : "Ranked from four separate components"}
                <small>
                  Reports {componentText(c.components.recentReports)} · ID {componentText(c.components.idQuality)} · Heat {componentText(c.components.heatStress)} · Completeness {componentText(c.components.completeness)}
                </small>
              </span>
            </Marker>
          ))
        : null}
    </Layer>
  );
}

/** One word label per area whose CRW pixels are all missing or stale at `atMs`, at the patch centre. */
export function heatLabels(areas: readonly Area[], pixels: readonly HeatPixel[], atMs: number): { lat: number; lon: number; text: string }[] {
  const out: { lat: number; lon: number; text: string }[] = [];
  for (const a of areas) {
    const mine = pixels.filter((px) => px.areaId === a.id);
    if (!mine.length) continue;
    const states = mine.map((px) => heatAt(px, atMs).state);
    const lat = mine.reduce((s, px) => s + px.lat, 0) / mine.length;
    const lon = mine.reduce((s, px) => s + px.lon, 0) / mine.length;
    if (states.every((s) => s === "missing")) out.push({ lat, lon, text: "No CRW product held for this day" });
    else if (states.every((s) => s !== "ok")) out.push({ lat, lon, text: "CRW stale: older than 72 h" });
  }
  return out;
}
