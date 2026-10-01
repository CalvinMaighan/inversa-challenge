"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { LAYERS, type LayersState } from "client/state/layers";
import { TAXA, type TaxaState } from "client/state/taxa";
import { THEME } from "client/state/theme";
import { retime, TIME, timeWindow, type TimeState } from "client/state/time";
import styled from "client/styled";
import { frameIndexAt, type FrameSightings } from "client/threads/api";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { Dot, Icon, IconButton, Mono, MOBILE, Surface } from "../primitives";
import { formatClocks, isLive } from "../topbar/clock";
import { drawTrack, TRACK, type TrackColors } from "./draw";
import { stepAt, timeAtStep, windowSteps } from "./frames";
import { frameGapFlags, GAP_FLAG } from "./gaps";
import { filteredCounts } from "./sparkline";
import { useFrameGrid, useFrameSightings } from "./use-frame-grid";

const [SIGHTINGS] = LAYER_IDS;

export const SPEEDS = [1, 2, 4, 8, 16, 32] as const;

const Root = styled(Surface)`
  position: absolute;
  left: max(var(--gap-m), env(safe-area-inset-left));
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: max(var(--gap-s), env(safe-area-inset-bottom));
  padding: 6px var(--gap-m) 8px;
  border-radius: var(--radius-m);
  z-index: 4;

  ${MOBILE} {
    left: var(--gap-s);
    right: var(--gap-s);
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

  /* A phone has the date and LIVE/REPLAY; the clock would only show cut off. */
  ${MOBILE} {
    display: none;
  }
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

const DateInput = styled.input`
  height: 28px;
  margin-left: var(--gap-s);
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  color-scheme: dark light;
  font: 600 11px / 1 var(--font-mono);
  /* Focus sits on the date field's inner segments, so the host never matches :focus-visible. */
  &:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  ${MOBILE} {
    margin-left: 0;
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

function togglePlay() {
  set<TimeState>(TIME, (prev = TIME.defaults) => {
    if (prev.playing) return { ...prev, playing: false };
    // Play from the live edge replays the window from the start.
    const atEnd = isLive(prev);
    return { ...prev, playing: true, at: atEnd ? prev.from : (prev.at ?? prev.to) };
  });
}

/** The sparkline's per-frame counts under the species filter, or null without sighting sections. */
function sparkCounts(sightings: FrameSightings | null, filter: LayersState["species"], taxa: TaxaState["byId"]): Uint32Array | null {
  if (!sightings) return null;
  return filteredCounts(sightings.counts.length, (i) => sightings.records(i), filter, taxa);
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
  const species = useActiveState<LayersState, LayersState["species"]>(LAYERS, (l) => l.species)[0] ?? LAYERS.defaults.species;
  const taxa = useActiveState<TaxaState, TaxaState["byId"]>(TAXA, (t) => t.byId)[0] ?? TAXA.defaults.byId;
  const at = useActiveState<TimeState, string>(TIME, (t) => t.at ?? t.to)[0] ?? "";
  const steps = windowSteps(from, to);

  // Counts only mean something when they index the same frames as the grid.
  const counts = sightings && meta && sightings.counts.length === meta.frameCount ? sightings.counts : null;
  // The line follows the species filter, as the globe does; the gap lane keeps every sighting (a quiet stretch
  // is a gap in the data, whatever is filtered).
  const shown = useMemo(() => sparkCounts(counts ? sightings : null, species, taxa), [counts, sightings, species, taxa]);
  // Recomputed per grid write, not per scrub step. `version` is the dependency that tracks SAB writes.
  const flags = useMemo(
    () => (grid && meta ? frameGapFlags(grid, counts, meta.stepMinutes * 60_000) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version changes when the grid's contents change
    [grid, meta, version, counts],
  );

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
    drawTrack(ctx, width, dpr, { fromMs: from, toMs: to, meta, flags, counts: shown }, readColors(canvas));
  }, [width, from, to, meta, flags, shown, theme]);

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
      else if (shown) lines.push(`${shown[frame]} sightings`);
      const f = frame !== null && flags ? flags[frame]! : 0;
      if (f & GAP_FLAG.ENV_MISSING) lines.push("gap: no satellite data");
      else if (f & GAP_FLAG.CLOUD) lines.push("gap: cloud over the satellite view");
      if (f & GAP_FLAG.NO_SIGHTINGS) lines.push("gap: no sightings for 12 h or more");
      if (f & GAP_FLAG.UNLOADED) lines.push("not loaded yet");
      tip.textContent = lines.join("\n");
      tip.style.visibility = "visible";
      const tipWidth = tip.offsetWidth;
      tip.style.transform = `translateX(${Math.min(rect.width - tipWidth, Math.max(0, fx * rect.width - tipWidth / 2))}px)`;
    },
    [shown, flags, meta, from, to, width],
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

/**
 * Date jump: a UTC day, committed on Enter or blur (not per keystroke, so typing a year does not fetch year 2).
 * The time of day is kept; a day outside the window moves the window (`retime`) and the db worker fetches it.
 */
function DateJump({ at }: { at: string }) {
  const day = at.slice(0, 10);
  const commit = (input: HTMLInputElement) => {
    if (!input.value || input.value === day) return;
    const ms = Date.parse(`${input.value}T${at.slice(11, 16)}:00Z`);
    if (!Number.isFinite(ms)) {
      input.value = day;
      return;
    }
    set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...retime(prev, ms, Date.now()), playing: false }));
  };
  return (
    <DateInput
      key={day}
      type="date"
      defaultValue={day}
      min="2000-01-01"
      max={new Date().toISOString().slice(0, 10)}
      aria-label="Jump to date (UTC)"
      title="Jump to date (UTC)"
      data-hud-date-jump=""
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget);
      }}
    />
  );
}

function PlayControls() {
  const playing = useActiveState<TimeState, boolean>(TIME, (t) => t.playing)[0] ?? false;
  const speed = useActiveState<TimeState, number>(TIME, (t) => t.speed)[0] ?? 8;
  const live = useActiveState<TimeState, boolean>(TIME, (t) => isLive(t, Date.now()))[0] ?? true;
  const at = useActiveState<TimeState, string>(TIME, (t) => t.at ?? t.to)[0] ?? "";
  usePlayback(playing, speed);
  const c = formatClocks(Date.parse(at));
  const showingNow = live && !playing;
  return (
    <Controls>
      <IconButton type="button" onClick={togglePlay} $active={playing} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} data-testid="hud-play">
        <Icon name={playing ? "pause" : "play"} />
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
      {/* Live versus replay lives here (T41): the state, and the way back to now. */}
      <LiveButton
        type="button"
        $live={showingNow}
        aria-disabled={showingNow}
        aria-label={showingNow ? "LIVE, showing now" : `${playing ? "REPLAY, playing" : "REPLAY"}: jump to now`}
        title={showingNow ? "Showing now" : "Showing the past: click to jump to now"}
        data-testid="hud-live"
        aria-live="polite"
        onClick={() => {
          if (!showingNow) set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...timeWindow(Date.now()), playing: false }));
        }}
      >
        <Dot $tone={showingNow ? "ok" : "warn"} $pulse={showingNow || playing} />
        {showingNow ? "LIVE" : playing ? "REPLAY ▸" : "REPLAY"}
      </LiveButton>
      <DateJump at={at} />
      <Readout title="Time cursor, UTC and Florida time">
        {c.utc.slice(0, 5)}Z · {c.local.slice(0, 5)} {c.zone}
      </Readout>
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
  const ref = useRef<HTMLDivElement>(null);
  // The globe's data attribution sits in the globe layer, under the HUD: lift it above the timeline, which would
  // otherwise cover it and take its clicks (GlobeView reads --globe-credits-bottom).
  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.closest<HTMLElement>('[data-slot="globe-pane"]');
    if (!el || !pane || typeof ResizeObserver !== "function") return;
    const apply = () => pane.style.setProperty("--globe-credits-bottom", `${Math.ceil(pane.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 4)}px`);
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    observer.observe(pane);
    apply();
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--globe-credits-bottom");
    };
  }, []);
  return (
    <Root as="section" ref={ref} data-hud-obstacle="" aria-label="Timeline" data-testid="hud-timeline" onKeyDown={onKeyDown}>
      <PlayControls />
      <TimelineTrack from={Date.parse(from)} to={Date.parse(to)} />
    </Root>
  );
}
