"use client";

import { useEffect, useMemo, useRef } from "react";

import { Surface } from "client/hud/primitives";
import { TIMELINE_STRIP_ROOM } from "client/hud/zoom/strip";
import styled from "client/styled";

import { FISH_COLOR, setFishSince, useFish, YEARS } from "./fish";

const MONTHS = YEARS * 12;

const Root = styled(Surface)`
  position: absolute;
  left: max(var(--gap-m), env(safe-area-inset-left));
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: max(var(--gap-m), env(safe-area-inset-bottom));
  padding: 6px var(--gap-m) 8px;
  border-radius: var(--radius-m);
  z-index: 4;
  /* The zoom strip sits at this row's right end. */
  ${TIMELINE_STRIP_ROOM}
`;

const Head = styled.div`
  display: flex;
  align-items: baseline;
  gap: var(--gap-m);
  margin-bottom: 4px;
  font: 600 12px / 1.3 var(--font-ui);

  small {
    margin-left: auto;
    color: var(--muted);
    font: 500 11px / 1.3 var(--font-mono);
  }
`;

const Track = styled.div`
  position: relative;
  height: 42px;

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: ew-resize;
  }
`;

/** The first day of the month `index` months into the window (0 is the oldest month). */
function monthStart(index: number, nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1 - index), 1);
}

const monthLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The carp timeline, like the sightings timeline of the other two apps but for the fish: sightings per month over the last five
 * years as bars, and a cursor to drag: only sightings from that month on show on the map.
 */
export default function FishTimeline() {
  const { windowed, shown, sinceMs, status } = useFish();
  const canvas = useRef<HTMLCanvasElement>(null);
  const nowMs = useMemo(() => Date.now(), []);

  const counts = useMemo(() => {
    const out = new Array<number>(MONTHS).fill(0);
    const origin = monthStart(0, nowMs);
    for (const s of windowed) {
      if (!s.date) continue;
      const t = Date.parse(s.date);
      const i = Math.floor((new Date(t).getUTCFullYear() - new Date(origin).getUTCFullYear()) * 12 + new Date(t).getUTCMonth() - new Date(origin).getUTCMonth());
      if (i >= 0 && i < MONTHS) out[i]! += 1;
    }
    return out;
  }, [windowed, nowMs]);

  const cursor = sinceMs === null ? 0 : Math.max(0, counts.findIndex((_, i) => monthStart(i, nowMs) >= sinceMs));

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    const g = el.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const max = Math.max(1, ...counts);
    const bw = w / MONTHS;
    counts.forEach((n, i) => {
      const bh = n === 0 ? 1 : Math.max(2, (n / max) * (h - 4));
      g.globalAlpha = i >= cursor ? 1 : 0.25;
      g.fillStyle = FISH_COLOR;
      g.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
    });
    g.globalAlpha = 1;
    g.fillStyle = "#e8edf2";
    g.fillRect(cursor * bw, 0, 2, h);
  }, [counts, cursor]);

  const since = sinceMs ?? monthStart(0, nowMs);
  return (
    <Root data-testid="fish-timeline">
      <Head>
        <span>Sightings over time</span>
        <small>
          {status === "ready" ? `${shown.length} since ${monthLabel(since)}` : status === "error" ? "could not load" : "loading…"}
        </small>
      </Head>
      <Track>
        <canvas ref={canvas} aria-hidden="true" />
        <input
          type="range"
          min={0}
          max={MONTHS - 1}
          step={1}
          value={cursor}
          aria-label="Show sightings from"
          aria-valuetext={monthLabel(since)}
          data-testid="fish-since"
          onChange={(e) => setFishSince(Number(e.currentTarget.value) === 0 ? null : monthStart(Number(e.currentTarget.value), nowMs))}
        />
      </Track>
    </Root>
  );
}
