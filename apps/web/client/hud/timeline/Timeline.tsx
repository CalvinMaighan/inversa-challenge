"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { get, set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { THEME } from "client/state/theme";
import { TIME, type TimeState } from "client/state/time";
import styled from "client/styled";
import { frameIndexAt } from "client/threads/api";

import { Icon, IconButton, Mono, MOBILE, Surface } from "../primitives";
import { useCell } from "../store";
import { alertRows } from "../Sync";
import { formatClocks, isLive } from "../topbar/clock";
import { alertBands } from "./alerts";
import { drawTrack, TRACK, type TrackColors } from "./draw";
import { stepAt, timeAtStep, windowSteps } from "./frames";
import { frameGapFlags, GAP_FLAG } from "./gaps";
import { useFrameGrid, useFrameSightings } from "./use-frame-grid";

export const SPEEDS = [1, 2, 4, 8, 16, 32] as const;

const Root = styled(Surface)`
  position: absolute;
  left: max(var(--gap-m), env(safe-area-inset-left));
  /* Leaves the bottom-right corner to the agent orb. */
  right: calc(max(var(--gap-l), env(safe-area-inset-right)) + 76px);
  bottom: max(var(--gap-s), env(safe-area-inset-bottom));
  padding: 6px var(--gap-m) 8px;
  border-radius: var(--radius-m);
  z-index: 4;

  ${MOBILE} {
    left: var(--gap-s);
    right: calc(var(--gap-s) + 64px);
    padding: 6px var(--gap-s) 6px;
  }
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
`;

const Readout = styled(Mono)`
  margin-left: var(--gap-s);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Legend = styled.span`
  margin-left: auto;
  display: flex;
  gap: var(--gap-s);
  color: var(--muted);
  font: 600 10px / 1 var(--font-mono);
  letter-spacing: 0.06em;
  white-space: nowrap;
  i {
    display: inline-block;
    width: 10px;
    height: 8px;
    margin-right: 3px;
    vertical-align: -1px;
  }
  ${MOBILE} {
    display: none;
  }
`;

const Swatch = styled.i<{ $color: string; $hatch?: boolean }>`
  background: ${(p) =>
    p.$hatch ? `repeating-linear-gradient(135deg, ${p.$color} 0 1.5px, transparent 1.5px 4px)` : p.$color};
`;

const Select = styled.select`
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
  touch-action: none;
`;

const Canvas = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
`;

/** The scrubber: a native range input over the canvas; its thumb is the cursor line. */
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

  &::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }
  &::-moz-range-track {
    height: 100%;
    background: transparent;
  }
  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 3px;
    height: ${TRACK.height}px;
    border-radius: 1px;
    background: var(--text);
    box-shadow: 0 0 0 1px var(--bg), 0 0 8px var(--hud-glow);
  }
  &::-moz-range-thumb {
    width: 3px;
    height: ${TRACK.height}px;
    border: 0;
    border-radius: 1px;
    background: var(--text);
  }
  &:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
`;

const Tip = styled(Mono)`
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  padding: 3px 6px;
  border-radius: var(--radius-s);
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 11px;
  white-space: pre;
  pointer-events: none;
  visibility: hidden;
  z-index: 1;
`;

function readColors(el: Element): TrackColors {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    text: v("--text", "#eee"),
    muted: v("--muted", "#999"),
    accent: v("--accent", "#d34b4d"),
    warn: v("--warn", "#f2c14e"),
    danger: v("--danger", "#d34b4d"),
    line: v("--hud-line", "#888"),
  };
}

function setStep(step: number) {
  set<TimeState>(TIME, (prev = TIME.defaults) => {
    const from = Date.parse(prev.from);
    const to = Date.parse(prev.to);
    const s = Math.min(windowSteps(from, to), Math.max(0, step));
    return { ...prev, at: new Date(timeAtStep(s, from)).toISOString(), playing: false };
  });
}

function nudge(delta: number) {
  const t = get<TimeState>(TIME) ?? TIME.defaults;
  const from = Date.parse(t.from);
  const to = Date.parse(t.to);
  setStep(stepAt(Date.parse(t.at ?? t.to), from, to) + delta);
}

function togglePlay() {
  set<TimeState>(TIME, (prev = TIME.defaults) => {
    if (prev.playing) return { ...prev, playing: false };
    // Play from the live edge replays the window from the start.
    const atEnd = isLive(prev);
    return { ...prev, playing: true, at: atEnd ? prev.from : (prev.at ?? prev.to) };
  });
}

/** Advance TIME.at by one step every `1000 / speed` ms while playing; stop on the live edge. */
function usePlayback(playing: boolean, speed: number) {
  useEffect(() => {
    if (!playing) return;
    const interval = 1000 / Math.max(0.25, speed);
    let last = performance.now();
    let carry = 0;
    let raf = 0;
    const loop = (now: number) => {
      carry += now - last;
      last = now;
      if (carry >= interval) {
        const steps = Math.floor(carry / interval);
        carry -= steps * interval;
        set<TimeState>(TIME, (prev = TIME.defaults) => {
          const from = Date.parse(prev.from);
          const to = Date.parse(prev.to);
          const next = stepAt(Date.parse(prev.at ?? prev.to), from, to) + steps;
          if (next >= windowSteps(from, to)) return { ...prev, at: prev.to, playing: false };
          return { ...prev, at: new Date(timeAtStep(next, from)).toISOString() };
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);
}

function TimelineTrack({ from, to }: { from: number; to: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [theme] = useActiveState(THEME);
  const { grid, meta, version } = useFrameGrid();
  const sightings = useFrameSightings();
  const alerts = useCell(alertRows);
  const at = useActiveState<TimeState, string>(TIME, (t) => t.at ?? t.to)[0] ?? "";
  const steps = windowSteps(from, to);

  // Counts only mean something when they index the same frames as the grid.
  const counts = sightings && meta && sightings.counts.length === meta.frameCount ? sightings.counts : null;
  // Recomputed per grid write, not per scrub step. `version` is the dependency that tracks SAB writes.
  const flags = useMemo(
    () => (grid && meta ? frameGapFlags(grid, counts, meta.stepMinutes * 60_000) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version changes when the grid's contents change
    [grid, meta, version, counts],
  );
  const bands = useMemo(() => alertBands(alerts, from, to), [alerts, from, to]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width <= 0) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(TRACK.height * dpr);
    drawTrack(ctx, width, dpr, { fromMs: from, toMs: to, meta, flags, counts, bands }, readColors(canvas));
  }, [width, from, to, meta, flags, counts, bands, theme]);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const tip = tipRef.current;
      if (!tip || width <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const ms = from + fx * (to - from);
      const frame = frameIndexAt(ms, meta);
      const clock = formatClocks(ms);
      const lines = [`${clock.date} ${clock.utc}`];
      if (frame === null) lines.push("outside the loaded frames");
      else if (counts) lines.push(`${counts[frame]} sightings`);
      const f = frame !== null && flags ? flags[frame]! : 0;
      if (f & GAP_FLAG.ENV_MISSING) lines.push("no satellite data");
      else if (f & GAP_FLAG.CLOUD) lines.push("cloud / masked");
      if (f & GAP_FLAG.NO_SIGHTINGS) lines.push("no sightings ≥12 h");
      if (f & GAP_FLAG.UNLOADED) lines.push("frame not loaded");
      for (const band of bands) if (ms >= band.startMs && ms < band.endMs) lines.push(`${band.event} (${band.severity})`);
      tip.textContent = lines.join("\n");
      tip.style.visibility = "visible";
      const tipWidth = tip.offsetWidth;
      tip.style.transform = `translateX(${Math.min(rect.width - tipWidth, Math.max(0, fx * rect.width - tipWidth / 2))}px)`;
    },
    [bands, counts, flags, meta, from, to, width],
  );

  const step = stepAt(Date.parse(at), from, to);
  const c = formatClocks(Date.parse(at));
  return (
    <Track onPointerMove={onPointerMove} onPointerLeave={() => tipRef.current && (tipRef.current.style.visibility = "hidden")}>
      <Canvas ref={canvasRef} data-testid="hud-timeline-canvas" />
      <Range
        type="range"
        min={0}
        max={steps}
        step={1}
        value={step}
        onChange={(e) => setStep(Number(e.currentTarget.value))}
        aria-label="Timeline"
        aria-valuetext={`${c.date} ${c.utc}`}
        data-hud-scrubber=""
      />
      <Tip ref={tipRef} aria-hidden="true" />
    </Track>
  );
}

function PlayControls() {
  const playing = useActiveState<TimeState, boolean>(TIME, (t) => t.playing)[0] ?? false;
  const speed = useActiveState<TimeState, number>(TIME, (t) => t.speed)[0] ?? 8;
  const live = useActiveState<TimeState, boolean>(TIME, (t) => isLive(t))[0] ?? true;
  const at = useActiveState<TimeState, string>(TIME, (t) => t.at ?? t.to)[0] ?? "";
  usePlayback(playing, speed);
  const c = formatClocks(Date.parse(at));
  return (
    <Controls>
      <IconButton type="button" onClick={() => nudge(-1)} aria-label="Step back 15 minutes" title="Step back (15 min)">
        <Icon name="prev" />
      </IconButton>
      <IconButton type="button" onClick={togglePlay} $active={playing} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} data-testid="hud-play">
        <Icon name={playing ? "pause" : "play"} />
      </IconButton>
      <IconButton type="button" onClick={() => nudge(1)} aria-label="Step forward 15 minutes" title="Step forward (15 min)">
        <Icon name="next" />
      </IconButton>
      <Select
        aria-label="Playback speed, frames per second"
        value={speed}
        onChange={(e) => set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, speed: Number(e.currentTarget.value) }))}
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </Select>
      <IconButton
        type="button"
        $active={live}
        disabled={live && !playing}
        onClick={() => set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, at: prev.to, playing: false }))}
        title="Jump to the live edge"
      >
        <Icon name="live" />
        Live
      </IconButton>
      <Readout>
        {c.date} {c.utc}
      </Readout>
      <Legend aria-hidden="true">
        <span>
          <Swatch $color="var(--accent)" />
          sightings
        </span>
        <span>
          <Swatch $color="var(--warn)" />
          alerts
        </span>
        <span>
          <Swatch $color="var(--danger)" $hatch />
          no data
        </span>
        <span>
          <Swatch $color="var(--warn)" $hatch />
          cloud
        </span>
        <span>
          <Swatch $color="var(--muted)" $hatch />
          quiet
        </span>
      </Legend>
    </Controls>
  );
}

export default function Timeline() {
  const from = useActiveState<TimeState, string>(TIME, (t) => t.from)[0] ?? TIME.defaults.from;
  const to = useActiveState<TimeState, string>(TIME, (t) => t.to)[0] ?? TIME.defaults.to;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === " " && target.tagName !== "BUTTON" && target.tagName !== "SELECT") {
      e.preventDefault();
      togglePlay();
    }
  };
  return (
    <Root as="section" data-hud-obstacle="" aria-label="Timeline" data-testid="hud-timeline" onKeyDown={onKeyDown}>
      <PlayControls />
      <TimelineTrack from={Date.parse(from)} to={Date.parse(to)} />
    </Root>
  );
}
