"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { onZoom, type ZoomApi, type ZoomState } from "client/globe/zoom/api";
import { altitudeToSlider, altitudeValueText, formatAltitude, PLACE_SCALES, placeScale, SLIDER_MAX, SLIDER_MIN, sliderToAltitude } from "client/globe/zoom/model";
import { useActiveApp } from "client/hud/appselect/use-active-app";
import styled from "client/styled";

import { MOBILE, Surface } from "../primitives";
import { STAGE_MEDIA } from "../shell/geometry";
import { ScaleIcon } from "./scale-icons";
import { STRIP_HEIGHT_PX, STRIP_WIDTH_CSS } from "./strip";
import { appHasSightings, fitSightings, resetView } from "./view";

/** Room kept above the timeline for the bottom bar and the Look button, px (the phone's + and - pair is centred above it). */
const BAR_ROOM_PX = 140;

/**
 * Zoom strip (gates/leaf-GE8.md, gates/leaf-GE10.md): the altitude slider with one icon per place scale (a globe for the
 * world ... a route for a street) and, under it, `-`, `+`, the altitude and Reset view and Fit sightings. A compact
 * strip in the timeline's row, at its right end, `--gap-m` from the timeline and the pane's edges (the timeline narrows
 * to make room, client/hud/zoom/strip.ts). The drag track is its leftmost element: far on the left, near on the right,
 * like `-` and `+` under it. A HUD too narrow for it inline puts it just above the timeline, still at the right; on a
 * phone only the `+`/`-` pair shows.
 *
 * Keys anywhere outside a text field or another widget: `+` / `-` step, Home resets. On the slider: arrows step,
 * Page Up / Page Down step twice, Home resets, End shows the whole planet.
 */
const Strip = styled(Surface)`
  position: absolute;
  /* A map control: under every card and sheet (panels are 3, the phone sheets 6). */
  z-index: 2;
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: max(var(--gap-m), env(safe-area-inset-bottom));
  width: ${STRIP_WIDTH_CSS};
  height: ${STRIP_HEIGHT_PX}px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 6px var(--gap-s);
  border-radius: var(--radius-m);
  font-family: var(--font-ui);

  /* A HUD too narrow for the strip beside the timeline: above it, at the right. */
  ${STAGE_MEDIA} {
    @container globe (max-width: 559px) {
      bottom: var(--hud-bottom);
    }
  }

  ${MOBILE} {
    /* The phone: the + and - pair, centred between the top row and the bottom bar. */
    top: calc((var(--hud-top) + 100% - var(--hud-bottom) - ${BAR_ROOM_PX}px) / 2);
    bottom: auto;
    right: var(--gap-m);
    transform: translateY(-50%);
    width: auto;
    height: auto;
    padding: 4px;

    [data-zoom-extra] {
      display: none;
    }
  }
`;

const Btn = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  cursor: pointer;

  &:hover {
    border-color: var(--hud-line);
    background: color-mix(in oklch, var(--text) 8%, transparent);
  }

  svg {
    width: 14px;
    height: 14px;
  }

  ${MOBILE} {
    width: 40px;
    height: 40px;

    svg {
      width: 16px;
      height: 16px;
    }
  }
`;

/** The buttons: - and + under the track's left and right, then the altitude, Reset view and Fit sightings. */
const Buttons = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;

  ${MOBILE} {
    flex-direction: column-reverse;
  }
`;

/** The scale: icons above the track, the track under them. */
const Scale = styled.div`
  position: relative;
  height: 34px;
`;

const Track = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 14px;
  border-radius: 7px;
  cursor: pointer;
  touch-action: none;

  &::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: color-mix(in oklch, var(--text) 22%, transparent);
  }

  &:focus-visible {
    outline-offset: 2px;
  }
`;

const Thumb = styled.span`
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  transform: translate(-50%, -50%);
  border: 2px solid var(--text);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 1px 4px rgb(0 0 0 / 45%);
  pointer-events: none;
`;

/** One place scale: its icon over its place on the track; the current one is lit. */
const Stop = styled.button<{ $on: boolean }>`
  position: absolute;
  top: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 18px;
  padding: 0;
  transform: translateX(-50%);
  border: 0;
  background: transparent;
  color: ${(p) => (p.$on ? "var(--accent)" : "var(--muted)")};
  cursor: pointer;

  svg {
    width: ${(p) => (p.$on ? 16 : 14)}px;
    height: ${(p) => (p.$on ? 16 : 14)}px;
  }
  &:hover {
    color: var(--text);
  }
`;

const Readout = styled.div`
  flex: 1;
  min-width: 0;
  text-align: center;
  color: var(--text);
  font: 600 11px / 1.2 var(--font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`;

const Hint = styled(Surface)`
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--gap-m));
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 210px;
  padding: 8px 8px 8px 10px;
  border-radius: var(--radius-m);
  font: 400 12px / 1.4 var(--font-ui);

  strong {
    display: block;
    font-weight: 700;
  }
  button {
    flex: none;
    height: 22px;
    min-width: 22px;
  }

  ${MOBILE} {
    width: 180px;
    right: calc(100% + var(--gap-m));
    bottom: auto;
    top: 0;
  }
`;

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PLUS = svg("M8 3v10M3 8h10");
const MINUS = svg("M3 8h10");
const HOME = svg("M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3v-3.5h2V13h3V6.5");
const FIT = svg("M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10M8 7.2v1.6M7.2 8h1.6");
const CLOSE = svg("M4 4l8 8M12 4l-8 8");

/** Where a slider value sits on the track (the right end is the closest view), inside the track's 7 px end caps. */
const TRACK_CAP_PX = 7;
const thumbLeft = (value: number) => `calc(${TRACK_CAP_PX}px + (100% - ${2 * TRACK_CAP_PX}px) * ${(value / SLIDER_MAX).toFixed(4)})`;

/** Once per browser session. */
const HINT_KEY = "inversa:zoom:3d-hint";
const HINT_MS = 9_000;

function hintSeen(): boolean {
  try {
    return sessionStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}
function markHintSeen(): void {
  try {
    sessionStorage.setItem(HINT_KEY, "1");
  } catch {
    // Private mode: the hint may show again next session, nothing else changes.
  }
}

/** Focus in a text field or in another composite widget (sliders, lists, menus, tabs): its own keys win. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return target.closest("[role=slider], [role=listbox], [role=option], [role=menu], [role=menuitem], [role=tablist], [role=tab], [role=grid], [role=combobox], [role=spinbutton], [role=radiogroup], [role=dialog]") !== null;
}

/** The controller's latest state, for `useSyncExternalStore` (a stable object between emissions). */
let snapshot: { api: ZoomApi | null; state: ZoomState | null } = { api: null, state: null };
const subscribeZoom = (cb: () => void) => {
  let off = () => {};
  const offApi = onZoom((api) => {
    off();
    snapshot = { api, state: api?.state() ?? null };
    off = api
      ? api.subscribe((state) => {
          snapshot = { api, state };
          cb();
        })
      : () => {};
    cb();
  });
  return () => {
    offApi();
    off();
  };
};
const zoomSnapshot = () => snapshot;
const noZoom = () => ({ api: null, state: null });

export default function ZoomControls() {
  const { api, state } = useSyncExternalStore(subscribeZoom, zoomSnapshot, noZoom);
  const app = useActiveApp();
  const [message, setMessage] = useState("");
  const [hint, setHint] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number } | null>(null);

  // The "3D city view" hint: the first time a zoom tilts the view over Google 3D, once per session.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = api.subscribe((s) => {
      if (!s.threeD || s.autoTilts === 0 || timer || hintSeen()) return;
      markHintSeen();
      setHint(true);
      timer = setTimeout(() => setHint(false), HINT_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [api]);

  // Keys outside the controls: + and - step, Home resets.
  useEffect(() => {
    if (!api) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || ownsKeys(e.target)) return;
      if (e.key === "+" || e.key === "=") api.step(1);
      else if (e.key === "-" || e.key === "_") api.step(-1);
      else if (e.key === "Home") resetView();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [api]);

  if (!api || !state) return null;

  const limits = { minM: state.minM, maxM: state.maxM };
  const value = altitudeToSlider(state.altitudeM, limits);
  const current = placeScale(state.altitudeM);

  const valueAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return value;
    return SLIDER_MAX * Math.min(1, Math.max(0, (clientX - r.left - TRACK_CAP_PX) / (r.width - 2 * TRACK_CAP_PX)));
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    trackRef.current?.focus();
    trackRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId };
    api.setAltitude(sliderToAltitude(valueAt(e.clientX), limits));
  };
  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    api.setAltitude(sliderToAltitude(valueAt(e.clientX), limits), { animate: false });
  };
  const onTrackUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onTrackKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 2, PageDown: -2 };
    if (e.key in steps) api.step(steps[e.key]!);
    else if (e.key === "Home") resetView();
    else if (e.key === "End") api.setAltitude(state.maxM);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const bands = PLACE_SCALES.map((s, i) => {
    const top = i === 0 ? state.maxM : PLACE_SCALES[i - 1]!.fromM;
    const bottom = Math.max(s.fromM, state.minM);
    return { name: s.name, at: Math.sqrt(top * bottom), show: top > state.minM };
  }).filter((b) => b.show);

  const fit = () => setMessage(fitSightings() ? "Showing every sighting on the map" : "No sightings on the map to fit");

  return (
    <Strip data-zoom-controls="" data-testid="zoom-controls" data-hud-obstacle="" role="group" aria-label="Zoom">
      <Scale data-zoom-extra="">
        {bands.map((b) => (
          <Stop
            key={b.name}
            type="button"
            $on={b.name === current}
            tabIndex={-1}
            aria-label={`Zoom to ${b.name.toLowerCase()} level`}
            aria-current={b.name === current ? "true" : undefined}
            title={b.name}
            data-testid="zoom-stop"
            data-scale={b.name}
            style={{ left: thumbLeft(altitudeToSlider(b.at, limits)) }}
            onClick={() => api.setAltitude(b.at)}
          >
            <ScaleIcon scale={b.name} />
          </Stop>
        ))}
        <Track
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Altitude"
          aria-orientation="horizontal"
          aria-valuemin={SLIDER_MIN}
          aria-valuemax={SLIDER_MAX}
          aria-valuenow={Math.round(value * 10) / 10}
          aria-valuetext={altitudeValueText(state.altitudeM)}
          aria-keyshortcuts="Home End"
          data-testid="zoom-slider"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
          onKeyDown={onTrackKey}
        >
          <Thumb style={{ left: thumbLeft(value) }} />
        </Track>
      </Scale>
      <Buttons>
        <Btn type="button" aria-label="Zoom out" aria-keyshortcuts="-" title="Zoom out (-)" data-testid="zoom-out" onClick={() => api.step(-1)}>
          {MINUS}
        </Btn>
        <Btn type="button" aria-label="Zoom in" aria-keyshortcuts="+" title="Zoom in (+)" data-testid="zoom-in" onClick={() => api.step(1)}>
          {PLUS}
        </Btn>
        <Readout data-zoom-extra="" data-testid="zoom-readout" aria-hidden="true">
          {formatAltitude(state.altitudeM)} up
        </Readout>
        <Btn data-zoom-extra="" type="button" aria-label="Reset view" aria-keyshortcuts="Home" title="Reset view (Home)" data-testid="zoom-reset" onClick={resetView}>
          {HOME}
        </Btn>
        {appHasSightings(app) ? (
          <Btn data-zoom-extra="" type="button" aria-label="Fit sightings" title="Fit sightings" data-testid="zoom-fit" onClick={fit}>
            {FIT}
          </Btn>
        ) : null}
      </Buttons>
      <VisuallyHidden aria-live="polite">{message}</VisuallyHidden>
      {hint ? (
        <Hint role="status" data-testid="zoom-hint">
          <span>
            <strong>3D city view</strong>
            Buildings are in 3D here. Ctrl + drag, or drag with two fingers, to tilt.
          </span>
          <Btn type="button" aria-label="Dismiss" onClick={() => setHint(false)}>
            {CLOSE}
          </Btn>
        </Hint>
      ) : null}
    </Strip>
  );
}
