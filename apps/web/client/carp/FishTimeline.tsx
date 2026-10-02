"use client";

import { useEffect, useMemo, useRef } from "react";

import { getGlobe } from "client/globe/api";
import { fitInPane } from "client/globe/fit";
import { Dot, Icon, IconButton, Mono, MOBILE, Surface } from "client/hud/primitives";
import { TRACK } from "client/hud/timeline/draw";
import { sparkY } from "client/hud/timeline/sparkline";
import { TIMELINE_STRIP_ROOM } from "client/hud/zoom/strip";
import styled from "client/styled";

import { CARP_AREAS } from "./areas";
import { FISH_COLOR, setFishAt, setFishRange, setFishSpeed, SPEEDS, toggleFishPlay, useFish, type Speed } from "./fish";

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

  ${MOBILE} {
    padding: 6px var(--gap-s) 6px;
  }
`;

/** The same controls row as the sightings timeline of the other apps (client/hud/timeline/Timeline.tsx). */
const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
`;

const LiveButton = styled.button<{ $live: boolean }>`
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

const Readout = styled(Mono)`
  margin-left: auto;
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  ${MOBILE} {
    display: none;
  }
`;

const SpeedSelect = styled.select`
  height: 28px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 11px / 1 var(--font-mono);
  option {
    background: var(--surface);
  }
`;

const Track = styled.div`
  position: relative;
  height: ${TRACK.height}px;

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  /* The scrubber: a native range over the canvas; its thumb is the cursor line, as in the sightings timeline. */
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: ew-resize;
  }
  input::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }
  input::-moz-range-track {
    height: 100%;
    background: transparent;
  }
  input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 3px;
    height: ${TRACK.height}px;
    border-radius: 1px;
    background: var(--text);
    box-shadow: 0 0 0 1px var(--bg), 0 0 8px var(--hud-glow);
  }
  input::-moz-range-thumb {
    width: 3px;
    height: ${TRACK.height}px;
    border: 0;
    border-radius: 1px;
    background: var(--text);
  }
  input:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
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
  /* Selected: the one location, framed by default. */
  button[aria-pressed="true"] {
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 22%, var(--surface));
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const dayLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The carp timeline, like the sightings timeline of the other apps: play and speed, a cursor over two years of sightings per month,
 * and the set locations above it. The map shows the sightings up to the cursor, fading with their age.
 */
export default function FishTimeline() {
  const { windowed, shown, atMs, playing, speed, status, startMs, endMs } = useFish();
  const canvas = useRef<HTMLCanvasElement>(null);
  const nowMs = useMemo(() => Date.now(), []);

  // Sightings per UTC day, so the line spikes on the days they were reported.
  const counts = useMemo(() => {
    const days = Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
    const out = new Array<number>(days).fill(0);
    for (const s of windowed) {
      if (!s.date) continue;
      const i = Math.floor((Date.parse(s.date) - startMs) / DAY_MS);
      if (i >= 0 && i < days) out[i]! += 1;
    }
    return out;
  }, [windowed, endMs, startMs]);

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
    const style = getComputedStyle(el);
    const accent = style.getPropertyValue("--accent").trim() || FISH_COLOR;
    // Faint ticks and dd.mm labels, as the sightings timeline of the other apps draws its days; here at the 1st of
    // each month, since two years of days would be a wall of ticks.
    const span = Math.max(1, endMs - startMs);
    g.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textBaseline = "top";
    let lastLabel = -Infinity;
    const first = new Date(startMs);
    for (let t = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1); t <= endMs; ) {
      const x = Math.round(((t - startMs) / span) * w) + 0.5;
      g.globalAlpha = 0.18;
      g.fillStyle = style.getPropertyValue("--hud-line").trim() || "#888";
      g.fillRect(x, 0, 1, h);
      // Labels at least 44 px apart, as the other timeline spaces its own.
      if (x + 30 < w && x - lastLabel >= 44) {
        lastLabel = x;
        g.globalAlpha = 0.5;
        g.fillStyle = style.getPropertyValue("--muted").trim() || "#999";
        g.fillText(`01.${String(new Date(t).getUTCMonth() + 1).padStart(2, "0")}`, x + 3, 1);
      }
      const d = new Date(t);
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    g.globalAlpha = 1;
    // A line with a faint fill under it, as the sightings timeline of the other apps draws it.
    const max = Math.max(1, ...counts);
    const top = TRACK.sparkTop;
    const bottom = top + TRACK.sparkHeight;
    const px = (i: number) => ((i + 0.5) / counts.length) * w;
    const py = (i: number) => top + sparkY(counts[i]!, max, TRACK.sparkHeight);
    g.beginPath();
    g.moveTo(0, bottom);
    counts.forEach((_, i) => g.lineTo(px(i), py(i)));
    g.lineTo(w, bottom);
    g.closePath();
    g.globalAlpha = 0.16;
    g.fillStyle = accent;
    g.fill();
    g.globalAlpha = 0.85;
    g.strokeStyle = accent;
    g.lineWidth = 1.25;
    g.beginPath();
    counts.forEach((_, i) => (i === 0 ? g.moveTo(px(i), py(i)) : g.lineTo(px(i), py(i))));
    g.stroke();
    g.globalAlpha = 1;
  }, [counts, endMs, startMs]);

  // LIVE only when the range ends today and the cursor is at its end.
  const live = endMs >= nowMs - DAY_MS && atMs >= endMs - DAY_MS;
  const showingNow = live && !playing;
  return (
    <Root data-testid="fish-timeline">
      <Areas role="group" aria-label="Locations">
        {CARP_AREAS.map((a) => (
          <button key={a.id} type="button" data-area={a.id} aria-pressed="true" onClick={() => getGlobe()?.flyTo({ ...(fitInPane(a.bbox, 24) ?? { lat: a.lat, lon: a.lon, altitudeM: a.altitudeM, heading: 0, pitch: -90 }), durationS: 1.2 })}>
            {a.name}
          </button>
        ))}
      </Areas>
      <Head>
        <IconButton type="button" $active={playing} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} title={playing ? "Pause" : "Play from the start date to the end date"} data-testid="fish-play" onClick={() => toggleFishPlay()}>
          <Icon name={playing ? "pause" : "play"} />
        </IconButton>
        <SpeedSelect aria-label="Playback speed" value={speed} data-testid="fish-speed" onChange={(e) => setFishSpeed(Number(e.currentTarget.value) as Speed)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </SpeedSelect>
        <LiveButton
          type="button"
          $live={showingNow}
          aria-disabled={showingNow}
          aria-label={showingNow ? "LIVE, showing now" : `${playing ? "REPLAY, playing" : "REPLAY"}: jump to now`}
          title={showingNow ? "Showing now" : "Showing the past: click to jump to now"}
          onClick={() => {
            if (!showingNow) setFishRange(startMs, nowMs, nowMs);
          }}
        >
          <Dot $tone={showingNow ? "ok" : "warn"} $pulse={showingNow || playing} />
          {showingNow ? "LIVE" : playing ? "REPLAY ▸" : "REPLAY"}
        </LiveButton>
        <Readout>{status === "ready" ? `${shown.length} sightings` : status === "error" ? "could not load" : "loading…"}</Readout>
      </Head>
      <Track>
        <canvas ref={canvas} aria-hidden="true" />
        <input
          type="range"
          min={startMs}
          max={endMs}
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
