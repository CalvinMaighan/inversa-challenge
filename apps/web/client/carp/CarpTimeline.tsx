"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dot, Icon, IconButton, MOBILE, Surface } from "client/hud/primitives";
import { useHudBottom } from "client/hud/shell/use-hud-bottom";
import styled from "client/styled";

import { conflictText } from "./briefing";
import { drawChart, yRange, type ChartColors, type ChartData } from "./chart";
import { localTime } from "./format";
import { HOUR, type Snapshot, type SourceConflict } from "./model";
import { forecastSourceLabel } from "./review";

export const CHART_HEIGHT = 150;
export const CHART_HEIGHT_MOBILE = 112;

const Root = styled(Surface)`
  position: absolute;
  left: max(var(--gap-m), env(safe-area-inset-left));
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: max(var(--gap-m), env(safe-area-inset-bottom));
  padding: 6px var(--gap-m) 8px;
  border-radius: var(--radius-m);
  z-index: 4;
  /* Series colours, darker on the light theme so lines and legend text keep their contrast. */
  --carp-usgs: #4fb3ff;
  --carp-nwps: #3fd6c6;
  --carp-forecast: #c89bff;
  html[data-theme="light"] & {
    --carp-usgs: #0a62a3;
    --carp-nwps: #08766c;
    --carp-forecast: #6e35b5;
  }
  ${MOBILE} {
    padding: 6px var(--gap-s);
  }
`;

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font: 500 12px / 1.3 var(--font-ui);
`;

const ModeButton = styled.button<{ $live: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid color-mix(in oklch, ${(p) => (p.$live ? "var(--ok)" : "var(--warn)")} 60%, transparent);
  border-radius: var(--radius-s);
  background: color-mix(in oklch, ${(p) => (p.$live ? "var(--ok)" : "var(--warn)")} 12%, transparent);
  color: var(--text);
  font: 600 11px / 1 var(--font-mono);
  letter-spacing: 0.06em;
  cursor: ${(p) => (p.$live ? "default" : "pointer")};
`;

const TextButton = styled.button`
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 12px / 1 var(--font-ui);
  cursor: pointer;
  &:hover {
    border-color: var(--hud-line);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const Label = styled.span`
  min-width: 0;
  color: var(--muted);
  b {
    color: var(--text);
    font-weight: 600;
  }
  ${MOBILE} {
    flex-basis: 100%;
  }
`;

/** A phone with no location chosen: the chart holds only the hint, so it gives the height back to the map. */
export const CHART_HEIGHT_MOBILE_EMPTY = 64;

const Track = styled.div<{ $empty: boolean }>`
  position: relative;
  height: ${CHART_HEIGHT}px;
  touch-action: none;
  ${MOBILE} {
    height: ${(p) => (p.$empty ? CHART_HEIGHT_MOBILE_EMPTY : CHART_HEIGHT_MOBILE)}px;
  }
`;

const Canvas = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
`;

const Range = styled.input`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  background: transparent;
  appearance: none;
  -webkit-appearance: none;
  cursor: ew-resize;
  opacity: 0;
  &:focus-visible {
    opacity: 1;
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
  &::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }
  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 2px;
    height: 100%;
    background: transparent;
  }
`;

const Legend = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-top: 4px;
  color: var(--muted);
  font: 400 11.5px / 1.3 var(--font-ui);
  i {
    display: inline-block;
    width: 14px;
    height: 0;
    margin-right: 5px;
    vertical-align: middle;
    border-top: 2px solid currentColor;
  }
  i.dot {
    width: 6px;
    height: 6px;
    border: 0;
    border-radius: 50%;
    background: currentColor;
  }
  i.hollow {
    width: 6px;
    height: 6px;
    border: 1.5px solid currentColor;
    border-radius: 50%;
  }
  i.band {
    height: 8px;
    border: 0;
    background: color-mix(in oklch, currentColor 30%, transparent);
  }
  i.dash {
    border-top-style: dashed;
  }
  span {
    white-space: nowrap;
  }
  ${MOBILE} {
    gap: 2px var(--gap-s);
    font-size: 11px;
  }
`;

const ConflictChip = styled.details`
  display: inline-block;
  position: relative;
  summary {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid color-mix(in oklch, var(--danger) 70%, transparent);
    border-radius: var(--radius-round);
    background: color-mix(in oklch, var(--danger) 14%, transparent);
    color: var(--text);
    font: 600 11.5px / 1 var(--font-ui);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  p {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 5;
    width: min(340px, 80vw);
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 400 12px / 1.45 var(--font-ui);
  }
`;

function readColors(el: Element): ChartColors {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    text: v("--text", "#eee"),
    muted: v("--muted", "#999"),
    line: v("--hud-line", "#888"),
    usgs: v("--carp-usgs", "#4fb3ff"),
    nwps: v("--carp-nwps", "#3fd6c6"),
    forecast: v("--carp-forecast", "#c89bff"),
    warn: v("--warn", "#f2c14e"),
    danger: v("--danger", "#d34b4d"),
    cursor: v("--text", "#fff"),
    bg: v("--surface", "#111"),
  };
}

export type CarpTimelineProps = {
  chart: ChartData;
  siteName: string | null;
  forecast: Snapshot | null;
  conflicts: readonly SourceConflict[];
  replaying: boolean;
  /** The theme mode: the canvas reads its colours from CSS, so a theme change redraws. */
  theme?: string;
  /** A scrubber step (every input event while dragging or stepping). */
  onScrub: (ms: number) => void;
  /** The scrubber released (change, pointer up, key up, blur): the exact as-of data may now be fetched. */
  onScrubEnd?: () => void;
  onLive: () => void;
  onYesterday: () => void;
  onPlay: () => void;
};

/** Hours of the chart window, the slider's steps. */
const stepsOf = (c: ChartData) => Math.max(1, Math.round((c.toMs - c.fromMs) / HOUR));

/**
 * Observed stage against the forecast in force, one site at a time: scrub (drag, arrow keys: an hour, Page keys: a
 * day) to see what was known at any past hour; play replays forward to now; LIVE returns.
 */
export default function CarpTimeline({ chart, siteName, forecast, conflicts, replaying, theme, onScrub, onScrubEnd, onLive, onYesterday, onPlay }: CarpTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const scrubEnd = useRef(onScrubEnd);
  useEffect(() => {
    scrubEnd.current = onScrubEnd;
  }, [onScrubEnd]);
  // React's onChange is the input event; the native change event is the release of a drag (or a key step), the
  // moment the as-of data is worth fetching. Pointer up, key up and blur end a scrub the same way.
  useEffect(() => {
    const el = rangeRef.current;
    if (!el) return;
    const end = () => scrubEnd.current?.();
    for (const type of ["change", "pointerup", "keyup", "blur"]) el.addEventListener(type, end);
    return () => {
      for (const type of ["change", "pointerup", "keyup", "blur"]) el.removeEventListener(type, end);
    };
  }, []);
  const [width, setWidth] = useState(0);

  // Panels, tabs and the bottom bar stop one gutter above the timeline, however tall it wrapped.
  useHudBottom(rootRef);
  const [height, setHeight] = useState(CHART_HEIGHT);
  const chartRef = useRef(chart);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry!.contentRect.width));
      setHeight(Math.round(entry!.contentRect.height));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  /** Draw now, synchronously: a scrub repaints in the same task as its input event. */
  const draw = useCallback(
    (cursorMs: number, live: boolean) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || width <= 0) return null;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
      if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
      const data = { ...chartRef.current, cursorMs, live };
      const out = drawChart(ctx, width, height, dpr, data, readColors(canvas));
      // What is on the canvas, in words a test can read (the canvas itself is pixels).
      canvas.dataset.series = `usgs:${data.usgsStage.length} nwps:${data.nwpsObserved.length} forecast:${data.forecast.length} spread:${data.spread.length} alerts:${data.alerts.length}`;
      canvas.dataset.thresholds = `${out.drawn.thresholds}/${data.thresholds.length}`;
      canvas.dataset.later = String(out.drawn.later);
      canvas.dataset.coverage = out.drawn.coverage;
      canvas.dataset.message = data.message ?? "";
      canvas.dataset.cursor = String(cursorMs);
      canvas.dataset.drawn = String((Number(canvas.dataset.drawn) || 0) + 1);
      return out;
    },
    [width, height],
  );

  useEffect(() => {
    chartRef.current = chart;
    draw(chart.cursorMs, chart.live);
  }, [chart, draw, theme]);
  const offChart = useMemo(() => yRange(chart).offChart, [chart]);

  const steps = stepsOf(chart);
  const nowStep = Math.floor((chart.nowMs - chart.fromMs) / HOUR);
  const step = Math.min(nowStep, Math.max(0, Math.round((chart.cursorMs - chart.fromMs) / HOUR)));

  const scrubTo = (s: number) => {
    const clamped = Math.min(nowStep, Math.max(0, s));
    const ms = clamped >= nowStep ? chart.nowMs : chart.fromMs + clamped * HOUR;
    draw(ms, clamped >= nowStep);
    onScrub(ms);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const by = e.key === "PageUp" ? 24 : e.key === "PageDown" ? -24 : e.key === "Home" ? -steps : e.key === "End" ? steps : 0;
    if (by) {
      e.preventDefault();
      scrubTo(step + by);
    }
  };

  const zone = chart.zone;
  const cursorText = chart.live ? `Live, ${localTime(chart.nowMs, zone)}` : `What we knew at ${localTime(chart.cursorMs, zone)}`;
  return (
    <Root ref={rootRef} data-testid="carp-timeline" data-hud-obstacle="" data-mode={chart.live ? "live" : "asof"}>
      <Controls>
        <IconButton type="button" onClick={onPlay} $active={replaying} aria-label={replaying ? "Pause replay" : "Replay forward to now"} aria-pressed={replaying} data-testid="carp-play">
          <Icon name={replaying ? "pause" : "play"} />
        </IconButton>
        <ModeButton
          type="button"
          $live={chart.live}
          aria-disabled={chart.live}
          onClick={() => !chart.live && onLive()}
          data-testid="carp-live"
          aria-label={chart.live ? "LIVE, showing what is known now" : "WHAT WE KNEW: back to live"}
          title={chart.live ? "Showing what is known now" : "Showing what was known at the cursor: click to go live"}
        >
          <Dot $tone={chart.live ? "ok" : "warn"} $pulse={chart.live} />
          {chart.live ? "LIVE" : "AS OF"}
        </ModeButton>
        <TextButton type="button" onClick={onYesterday} data-testid="carp-yesterday">
          What we knew yesterday afternoon
        </TextButton>
        <Label data-testid="carp-asof-label" aria-live="polite">
          <b>{siteName ?? "No location selected"}</b> · {cursorText}
          {forecast ? (
            <>
              {" "}
              · forecast issued <b data-testid="carp-issued">{localTime(Date.parse(forecast.issuedAt), zone)}</b> ({forecastSourceLabel(forecast.source)})
            </>
          ) : siteName ? (
            " · no river forecast held then"
          ) : null}
        </Label>
      </Controls>
      <Track $empty={!siteName}>
        <Canvas
          ref={canvasRef}
          data-testid="carp-chart"
          role="img"
          aria-label={siteName ? `${siteName}: observed stage and river forecast, ${cursorText}. The numbers are in the location briefing.` : (chart.message ?? "Stage chart")}
        />
        <Range
          ref={rangeRef}
          type="range"
          min={0}
          max={steps}
          step={1}
          value={chart.live ? nowStep : step}
          onChange={(e) => scrubTo(Number(e.currentTarget.value))}
          onKeyDown={onKey}
          aria-label="What we knew: time"
          aria-valuetext={cursorText}
          data-carp-scrubber=""
        />
      </Track>
      {/* Nothing is drawn until a location is chosen, so there is nothing to key yet (a phone keeps the rows for the map). */}
      {siteName ? (
        <Legend data-testid="carp-legend">
          <span>
            <i style={{ color: "var(--carp-usgs)" }} />
            USGS gauge height (USGS datum)
          </span>
          <span>
            <i className="dot" style={{ color: "var(--carp-nwps)" }} />
            NWPS observed stage (flood datum{chart.live ? "" : ", by observation time"})
          </span>
          <span>
            <i style={{ color: "var(--carp-forecast)" }} />
            NWPS forecast
          </span>
          <span>
            <i className="band" style={{ color: "var(--carp-forecast)" }} />
            spread of last 3 issuances (not a confidence band)
          </span>
          {!chart.live ? (
            <span style={{ color: "var(--text)" }} data-testid="carp-later-legend">
              <i className="dash" />
              <i className="hollow" />
              observed after the as-of time (what happened next)
            </span>
          ) : null}
          {chart.alerts.length ? (
            <span>
              <i className="band" style={{ color: "var(--warn)" }} />
              NWS alert in effect ({chart.alerts.map((a) => a.label).join(", ")})
            </span>
          ) : null}
          <span>
            <i className="dash" style={{ color: "var(--warn)" }} />
            flood thresholds (NWPS{chart.live ? "" : ", as published now"})
          </span>
          {offChart
            .filter((o) => o.aboveFt > 0)
            .slice(0, 1)
            .map((o) => (
              <span key={o.label} data-testid="carp-offchart">
                {o.label} {o.ft} ft is {o.aboveFt.toFixed(1)} ft above the chart
              </span>
            ))}
          {conflicts.map((c) => {
            const t = conflictText(c, zone);
            return (
              <ConflictChip key={c.kind} data-testid="carp-conflict-chip" data-kind={c.kind}>
                <summary>
                  <Dot $tone="danger" />
                  Sources disagree: {c.kind}
                </summary>
                <p>{t.detail}</p>
              </ConflictChip>
            );
          })}
        </Legend>
      ) : null}
    </Root>
  );
}
