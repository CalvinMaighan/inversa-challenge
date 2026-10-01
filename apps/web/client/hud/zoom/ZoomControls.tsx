"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { onZoom, type ZoomApi, type ZoomState } from "client/globe/zoom/api";
import { altitudeToSlider, altitudeValueText, formatAltitude, PLACE_SCALES, placeScale, SLIDER_MAX, SLIDER_MIN, sliderToAltitude } from "client/globe/zoom/model";
import { useActiveApp } from "client/hud/appselect/use-active-app";
import styled from "client/styled";

import { MOBILE, Surface } from "../primitives";
import { FULL_WIDTH_PX, placeColumn, TAB_ROOM_PX } from "./place";
import { appHasSightings, fitSightings, resetView } from "./view";

/** Room kept above the timeline for the bottom bar and the Look button, px. */
const BAR_ROOM_PX = 140;
/** The full column's height before it is first measured, px. */
const FULL_HEIGHT_GUESS_PX = 316;

/**
 * Zoom controls (gates/leaf-GE8.md): `+` and `-`, a log-scale altitude slider labelled in plain place scales
 * (World … Street) with the altitude under it, Reset view and Fit sightings. A column at the right of the globe,
 * centred between the top row and the bottom bar, in the rightmost free slot: left of the sighting card and any
 * other card on that side (`data-hud-obstacle`), measured as they open and close. Where even that leaves no room,
 * and on a phone, only the `+`/`-` pair shows.
 *
 * Keys anywhere outside a text field or another widget: `+` / `-` step, Home resets. On the slider: arrows step,
 * Page Up / Page Down step twice, Home resets, End shows the whole planet.
 */
const Column = styled(Surface)`
  position: absolute;
  /* A map control: under every card and sheet (panels are 3, the phone sheets 6), which it otherwise keeps clear of. */
  z-index: 2;
  /* Centred between the top row and the bottom bar's row (the bar and the Look button keep BAR_ROOM_PX). */
  top: calc((var(--hud-top) + 100% - var(--hud-bottom) - ${BAR_ROOM_PX}px) / 2);
  /* First paint: clear of the sighting card's collapsed tab; then the measured slot (--zoom-right). */
  right: var(--zoom-right, max(${TAB_ROOM_PX}px, env(safe-area-inset-right)));
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  width: ${FULL_WIDTH_PX}px;
  padding: 6px;
  border-radius: var(--radius-m);
  font-family: var(--font-ui);

  [data-drawer-open] & {
    right: var(--zoom-right, calc(min(400px, 100cqw - 2 * var(--gap-m)) + 2 * var(--gap-m)));
  }

  &[data-compact] {
    width: auto;
    padding: 4px;

    [data-zoom-extra] {
      display: none;
    }
  }

  ${MOBILE} {
    width: auto;
    right: var(--zoom-right, var(--gap-s));
    padding: 4px;

    [data-drawer-open] & {
      right: var(--zoom-right, var(--gap-s));
    }
    [data-zoom-extra] {
      display: none;
    }
  }
`;

const Btn = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  min-width: 32px;
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
    width: 16px;
    height: 16px;
  }

  ${MOBILE} {
    width: 40px;
    height: 40px;
  }
`;

const Row = styled.div`
  display: flex;
  gap: 4px;

  & > button {
    flex: 1;
  }
`;

const SliderBox = styled.div`
  position: relative;
  height: 168px;
  margin: 4px 0;
`;

/** The track sits at the right; the labels fill the room to its left. */
const Track = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 36px;
  border-radius: 18px;
  cursor: pointer;
  touch-action: none;

  &::before {
    content: "";
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 50%;
    width: 4px;
    transform: translateX(-50%);
    border-radius: 2px;
    background: color-mix(in oklch, var(--text) 22%, transparent);
  }

  &:focus-visible {
    outline-offset: 2px;
  }
`;

const Thumb = styled.span`
  position: absolute;
  left: 50%;
  width: 18px;
  height: 18px;
  transform: translate(-50%, -50%);
  border: 2px solid var(--text);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 1px 4px rgb(0 0 0 / 45%);
  pointer-events: none;
`;

const Label = styled.span<{ $on: boolean }>`
  position: absolute;
  right: 40px;
  transform: translateY(-50%);
  color: ${(p) => (p.$on ? "var(--text)" : "var(--muted)")};
  font: ${(p) => (p.$on ? 700 : 500)} 10px / 1 var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
`;

const Readout = styled.div`
  text-align: center;
  color: var(--text);
  font: 600 12px / 1.2 var(--font-mono);
  font-variant-numeric: tabular-nums;
`;

const Hint = styled(Surface)`
  position: absolute;
  right: calc(100% + 8px);
  top: 0;
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

/** Where a slider value sits on the track (top is the closest view), inside the track's 6 px end caps. */
const TRACK_CAP_PX = 6;
const thumbTop = (value: number) => `calc(${TRACK_CAP_PX}px + (100% - ${2 * TRACK_CAP_PX}px) * ${(1 - value / SLIDER_MAX).toFixed(4)})`;

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
  const colRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number } | null>(null);
  const ready = api !== null && state !== null;

  // The column's slot: re-measured when the pane resizes or a card opens, closes or changes (one pass a frame).
  useLayoutEffect(() => {
    const col = colRef.current;
    if (!ready || !col || typeof ResizeObserver !== "function") return;
    let fullHeight = FULL_HEIGHT_GUESS_PX;
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!col.hasAttribute("data-compact") && col.offsetHeight > 0) fullHeight = col.offsetHeight;
      placeColumn(col, fullHeight);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    const root = col.closest("[data-hud]") ?? document.body;
    const resize = new ResizeObserver(schedule);
    resize.observe(col.offsetParent ?? root);
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { childList: true, subtree: true });
    place();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [ready]);

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

  const valueAt = (clientY: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.height <= 0) return value;
    return SLIDER_MAX * (1 - Math.min(1, Math.max(0, (clientY - r.top - TRACK_CAP_PX) / (r.height - 2 * TRACK_CAP_PX))));
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    trackRef.current?.focus();
    trackRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId };
    api.setAltitude(sliderToAltitude(valueAt(e.clientY), limits));
  };
  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    api.setAltitude(sliderToAltitude(valueAt(e.clientY), limits), { animate: false });
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
    <Column ref={colRef} data-zoom-controls="" data-testid="zoom-controls" data-hud-obstacle="" role="group" aria-label="Zoom">
      <Btn type="button" aria-label="Zoom in" aria-keyshortcuts="+" title="Zoom in (+)" data-testid="zoom-in" onClick={() => api.step(1)}>
        {PLUS}
      </Btn>
      <SliderBox data-zoom-extra="">
        {bands.map((b) => (
          <Label key={b.name} $on={b.name === current} aria-hidden="true" style={{ top: thumbTop(altitudeToSlider(b.at, limits)) }} onClick={() => api.setAltitude(b.at)}>
            {b.name}
          </Label>
        ))}
        <Track
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Altitude"
          aria-orientation="vertical"
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
          <Thumb style={{ top: thumbTop(value) }} />
        </Track>
      </SliderBox>
      <Btn type="button" aria-label="Zoom out" aria-keyshortcuts="-" title="Zoom out (-)" data-testid="zoom-out" onClick={() => api.step(-1)}>
        {MINUS}
      </Btn>
      <Readout data-zoom-extra="" data-testid="zoom-readout" aria-hidden="true">
        {formatAltitude(state.altitudeM)} up
      </Readout>
      <Row data-zoom-extra="">
        <Btn type="button" aria-label="Reset view" aria-keyshortcuts="Home" title="Reset view (Home)" data-testid="zoom-reset" onClick={resetView}>
          {HOME}
        </Btn>
        {appHasSightings(app) ? (
          <Btn type="button" aria-label="Fit sightings" title="Fit sightings" data-testid="zoom-fit" onClick={fit}>
            {FIT}
          </Btn>
        ) : null}
      </Row>
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
    </Column>
  );
}
