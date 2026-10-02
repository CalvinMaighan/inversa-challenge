"use client";

import { useEffect, useMemo, useRef } from "react";

import { getGlobe } from "client/globe/api";
import { Surface } from "client/hud/primitives";
import { TIMELINE_STRIP_ROOM } from "client/hud/zoom/strip";
import styled from "client/styled";

import { CARP_AREAS } from "./areas";
import { FISH_COLOR, setFishAt, setFishSpeed, SPEEDS, toggleFishPlay, useFish, windowStartMs, YEARS, type Speed } from "./fish";

const MONTHS = YEARS * 12;
const DAY_MS = 86_400_000;

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
  align-items: center;
  gap: var(--gap-s);
  margin-bottom: 4px;
  font: 600 12px / 1.3 var(--font-ui);

  small {
    margin-left: auto;
    color: var(--muted);
    font: 500 11px / 1.3 var(--font-mono);
  }
`;

const PlayButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  cursor: pointer;

  &:hover {
    border-color: var(--hud-line);
  }
  svg {
    width: 14px;
    height: 14px;
  }
`;

const SpeedSelect = styled.select`
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 12px / 1 var(--font-mono);
`;

const Track = styled.div`
  position: relative;
  height: 36px;

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

/** The set locations, inline above the timeline at its left: a click flies to the cluster. */
const Areas = styled.div`
  position: absolute;
  left: 0;
  bottom: calc(100% + var(--gap-m));
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-s);

  button {
    height: 28px;
    padding: 0 var(--gap-m);
    border: 1px solid var(--border);
    border-radius: var(--radius-round);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 600 12px / 1 var(--font-ui);
    cursor: pointer;
  }
  button:hover {
    border-color: var(--hud-line);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const PLAY = (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
);
const PAUSE = (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
  </svg>
);

const dayLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The carp timeline, like the sightings timeline of the other apps: play and speed, a cursor over two years of sightings per month,
 * and the set locations above it. The map shows the sightings up to the cursor, fading with their age.
 */
export default function FishTimeline() {
  const { windowed, shown, atMs, playing, speed, status } = useFish();
  const canvas = useRef<HTMLCanvasElement>(null);
  const nowMs = useMemo(() => Date.now(), []);
  const startMs = useMemo(() => windowStartMs(nowMs), [nowMs]);

  const counts = useMemo(() => {
    const out = new Array<number>(MONTHS).fill(0);
    const span = nowMs - startMs;
    for (const s of windowed) {
      if (!s.date) continue;
      const i = Math.floor(((Date.parse(s.date) - startMs) / span) * MONTHS);
      if (i >= 0 && i < MONTHS) out[i]! += 1;
    }
    return out;
  }, [windowed, nowMs, startMs]);

  const cursorFrac = Math.min(1, Math.max(0, (atMs - startMs) / (nowMs - startMs)));

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
      g.globalAlpha = (i + 0.5) / MONTHS <= cursorFrac ? 1 : 0.25;
      g.fillStyle = FISH_COLOR;
      g.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
    });
    g.globalAlpha = 1;
    g.fillStyle = "#e8edf2";
    g.fillRect(Math.min(w - 2, cursorFrac * w), 0, 2, h);
  }, [counts, cursorFrac]);

  const live = atMs >= nowMs - DAY_MS;
  return (
    <Root data-testid="fish-timeline">
      <Areas role="group" aria-label="Locations">
        {CARP_AREAS.map((a) => (
          <button key={a.id} type="button" data-area={a.id} onClick={() => getGlobe()?.flyTo({ lat: a.lat, lon: a.lon, altitudeM: a.altitudeM, heading: 0, pitch: -90, durationS: 1.2 })}>
            {a.name}
          </button>
        ))}
      </Areas>
      <Head>
        <PlayButton type="button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play through two years of sightings"} data-testid="fish-play" onClick={() => toggleFishPlay(nowMs)}>
          {playing ? PAUSE : PLAY}
        </PlayButton>
        <SpeedSelect aria-label="Playback speed" value={speed} data-testid="fish-speed" onChange={(e) => setFishSpeed(Number(e.currentTarget.value) as Speed)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </SpeedSelect>
        <span>{live ? "Now" : dayLabel(atMs)}</span>
        <small>{status === "ready" ? `${shown.length} sightings` : status === "error" ? "could not load" : "loading…"}</small>
      </Head>
      <Track>
        <canvas ref={canvas} aria-hidden="true" />
        <input
          type="range"
          min={startMs}
          max={nowMs}
          step={DAY_MS}
          value={atMs}
          aria-label="Time"
          aria-valuetext={live ? "Now" : dayLabel(atMs)}
          data-testid="fish-cursor"
          onChange={(e) => setFishAt(Number(e.currentTarget.value))}
        />
      </Track>
    </Root>
  );
}
