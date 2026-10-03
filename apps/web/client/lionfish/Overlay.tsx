"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { get } from "@calvinjs/active-state";

import { onGlobeReady, type DrapedImage } from "client/globe/api";
import { VIEW, type ViewState } from "client/state/view";
import { SELECTION, type SelectionState } from "client/state/selection";
import { STAGE_SCOPE_CSS } from "client/hud/shell/StageShell";
import styled from "client/styled";

import ImageGlyph from "client/media/ImageGlyph";

import { drawField } from "./draw";
import { reefImage, reefUrl, wideTiles, wideUrls, type ReefMode } from "./reef";
import { componentText, heatAt, isLate, isoDay, type Area, type HeatPixel, type MarinePoint, type PriorityCell, type Report } from "./model";

const Layer = styled.div`
  position: absolute;
  /* Canvas pixels: the HUD chrome this sits in starts right of the chat card (--chat-inset, GE1), the globe at 0. */
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

  /* A report: one dot per record, by date basis. */
  &[data-kind="report"] {
    width: 9px;
    height: 9px;
    margin: -4.5px 0 0 -4.5px;
    border-radius: 50%;
    background: var(--lionfish, #a06cd5);
    box-shadow: 0 0 0 1.5px rgb(0 0 0 / 70%), 0 1px 3px rgb(0 0 0 / 60%);
  }
  /* Selected: a halo, and a disc in the species' colour that pulses outward, as on the Inversa site. */
  &[data-kind="report"][data-selected] {
    z-index: 9;
    box-shadow: 0 0 0 1.5px #0b0d12, 0 0 0 5px color-mix(in oklch, var(--lionfish, #a06cd5) 35%, transparent);
  }
  &[data-kind="report"][data-selected]::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--lionfish, #a06cd5);
    pointer-events: none;
    @keyframes dot-pulse {
      from {
        transform: scale(1);
        opacity: 0.6;
      }
      to {
        transform: scale(4);
        opacity: 0;
      }
    }
    animation: dot-pulse 1.6s ease-out infinite;
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
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
  /** The reef heat map shown when `show.heat` is on. */
  reef: ReefMode;
  marine: readonly MarinePoint[] | null;
  show: { reports: boolean; heat: boolean; priority: boolean; field: boolean };
  selectedCell: string | null;
  onReport: (r: Report) => void;
  onCell: (c: PriorityCell) => void;
};

type Placed = { lat: number; lon: number };

const HEAT_ALPHA = 0.15;
/** The timeline must rest this long before the reef pictures change to its day. */
const SCRUB_SETTLE_MS = 450;
/** Each tile is laid a cell (0.05 degrees) wider than its grid box, so neighbours overlap instead of leaving a hairline between them. */
const SEAM_DEG = 0.05;

/** One entry per wide tile, `west,south,east,north|url`, joined by `;`. */
function keyOf(areas: readonly Area[], reef: ReefMode, atMs: number): string {
  const urls = wideUrls(areas, reef, atMs);
  return wideTiles(areas)
    .map((t, i) => `${t.west},${t.south},${t.east},${t.north}|${urls[i]}`)
    .join(";");
}
/** From this camera height up, the wide tiles (draped on the globe) show the reef heat; below it the finer area pictures do. */
const WIDE_MIN_ALTITUDE_M = 1_500_000;
/**
 * The lionfish layers over the globe: a canvas for CRW heat pixels and field-window glyphs (redrawn after every
 * globe frame), and buttons for reports and ranked cells (keyboard and screen readers reach them), positioned
 * over their globe points after every render and hidden behind the globe.
 */
export default function Overlay(p: OverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The wide reef pictures draped on the globe, and whether they are showing (camera high enough). */
  const wideLayers = useRef<DrapedImage[]>([]);
  const wideOn = useRef(false);
  const selectedEvidence = useActiveState<SelectionState, string | null>(SELECTION, (s) => s.evidenceId)[0] ?? null;
  const refs = useRef(new Map<string, { el: HTMLButtonElement; at: Placed }>());
  const props = useRef(p);
  const redraw = useRef<() => void>(() => {});
  useEffect(() => {
    props.current = p;
    redraw.current();
  });

  // The wide reef heat: the pictures are imagery on the globe (they follow its curve and meet without seams), one per tile
  // of the global grid. They change with the map and the product day, so their URLs are the key.
  const liveKey = p.show.heat ? keyOf(p.areas, p.reef, p.atMs) : "";
  // Scrubbing the timeline changes the product day many times a second: the pictures follow once it settles.
  const [wideKey, setWideKey] = useState(liveKey);
  useEffect(() => {
    const t = setTimeout(() => setWideKey(liveKey), liveKey === "" ? 0 : SCRUB_SETTLE_MS);
    return () => clearTimeout(t);
  }, [liveKey]);
  const shown = useRef<DrapedImage[]>([]);
  useEffect(() => {
    if (!wideKey) {
      for (const l of shown.current) l.remove();
      shown.current = [];
      wideLayers.current = [];
      redraw.current();
      return;
    }
    let cancelled = false;
    let fresh: DrapedImage[] = [];
    const stop = onGlobeReady((api) => {
      if (!api.drape) return;
      // The new day's pictures load beside the old ones; the old ones go when the new are on the globe, so the heat never blinks out.
      fresh = wideKey.split(";").flatMap((entry) => {
        const [box, url] = entry.split("|") as [string, string];
        const [west, south, east, north] = box.split(",").map(Number) as [number, number, number, number];
        const layer = api.drape!({ url, west: west - SEAM_DEG, south: south - SEAM_DEG, east: east + SEAM_DEG, north: north + SEAM_DEG, alpha: 0 });
        return layer ? [layer] : [];
      });
      void Promise.all(fresh.map((l) => l.ready)).then(() => {
        if (cancelled) return;
        for (const l of shown.current) l.remove();
        shown.current = fresh;
        wideLayers.current = fresh;
        for (const l of fresh) l.setAlpha(wideOn.current ? HEAT_ALPHA : 0);
        redraw.current();
      });
    });
    return () => {
      cancelled = true;
      stop();
      // Not on the globe yet (or superseded): stop loading them. The ones already showing stay until a newer set replaces them.
      if (shown.current !== fresh) for (const l of fresh) l.remove();
    };
  }, [wideKey]);
  useEffect(
    () => () => {
      for (const l of shown.current) l.remove();
      shown.current = [];
      wideLayers.current = [];
    },
    [],
  );

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
        // Reef heat. From high up the wide tiles are draped on the globe as imagery (see the effect above); closer in, one
        // finer NOAA picture per area, the chosen map for the product day at the cursor, pinned by its corners.
        const wide = (get<ViewState>(VIEW)?.altitudeM ?? 0) >= WIDE_MIN_ALTITUDE_M;
        if (wide !== wideOn.current) {
          wideOn.current = wide;
          for (const l of wideLayers.current) l.setAlpha(wide ? HEAT_ALPHA : 0);
        }
        let maps = cur.show.heat && wide ? wideLayers.current.length : 0;
        if (cur.show.heat && !wide) {
          for (const a of cur.areas) {
            const img = reefImage(reefUrl(a, cur.reef, cur.atMs), () => redraw.current());
            const nw = project(a.bbox.west, a.bbox.north);
            const se = project(a.bbox.east, a.bbox.south);
            if (!img || !nw || !se) continue;
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = HEAT_ALPHA;
            ctx.drawImage(img, Math.min(nw.x, se.x), Math.min(nw.y, se.y), Math.abs(se.x - nw.x), Math.abs(se.y - nw.y));
            ctx.restore();
            maps += 1;
          }
        }
        const field = cur.show.field && cur.marine ? drawField(ctx, cur.marine, project) : 0;
        canvas.dataset.heatMaps = String(maps);
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
              data-late={isLate(r) ? "" : undefined}
              data-selected={selectedEvidence === `sighting:${r.id}` ? "" : undefined}
              data-hidden=""
              aria-label={reportLabel(r)}
              onClick={() => p.onReport(r)}
            >
              <span className="tip" role="tooltip" aria-hidden="true">
                <b>
                  {`Lionfish report · ${sourceName(r.source)}`}
                  {r.photoUrl ? <ImageGlyph /> : null}
                </b>
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
