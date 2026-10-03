"use client";

import { useId, type KeyboardEvent } from "react";
import { set } from "@calvinjs/active-state";

import { LOOK_PRESETS } from "client/globe/look/presets";
import {
  blurOf,
  DEFAULT_SCOPE_BLUR,
  featherOf,
  LOOK,
  MAX_SCOPE_BLUR,
  MAX_SCOPE_FEATHER,
  MAX_SCOPE_SIZE,
  MIN_SCOPE_SIZE,
  SCOPE_BLUR,
  SCOPE_FEATHER,
  SCOPE_SHAPE,
  SCOPE_SHAPES,
  SCOPE_SIZE,
  shapeOf,
  sizeOf,
  type LookId,
  type ScopeShape,
} from "client/state/look";
import styled from "client/styled";

import { GLASS_CSS, IconButton, POPOVER_BUTTONS_CSS, Surface } from "../primitives";

/**
 * The Look controls (docs/GODS_EYE.md GC2, GE9, GE11): the seven presets and the map window: its shape and size
 * (always fully visible) and its soft edge (how the map fades out beyond it; there is no on/off). The button that opens them is an icon in the top-right cluster (client/hud/topbar,
 * between Theme and Developer); this module holds the popover's body and the writers, and the bottom bar's pill
 * and popover styles that Layers uses.
 */

/** A bottom-bar control: the pill and its popover anchor (Layers, client/hud/layers). */
export const Bar = styled.div`
  position: relative;
  display: flex;
  justify-content: center;
`;

export const Round = styled(Surface.withComponent("button"))`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 16px;
  color: var(--text);
  font: 600 12px / 1 var(--font-ui);
  letter-spacing: 0.04em;
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
  }

  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--hud-line);
  }
`;

/** A bottom-bar popover: opens upwards, one gutter above its pill, centred on it. */
export const Popover = styled.div`
  position: absolute;
  pointer-events: auto;
  bottom: calc(100% + var(--gap-m));
  left: 50%;
  transform: translateX(-50%);
  z-index: 9;
  width: min(300px, calc(100cqw - 2 * var(--gap-m)));
  padding: var(--gap-m);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  ${GLASS_CSS}
  color: var(--text);
  font: 400 13px / 1.45 var(--font-ui);
  ${POPOVER_BUTTONS_CSS}

  &:focus-visible {
    outline-offset: -2px;
  }

  h3 {
    margin: 0 0 var(--gap-s);
    color: var(--muted);
    font: 600 11px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
`;

const Heading = styled.h3`
  margin: 0 0 var(--gap-s);
  color: var(--muted);
  font: 600 11px / 1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
`;

const Presets = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-bottom: var(--gap-m);

  button {
    height: 30px;
    padding: 0;
  }
`;

/** A line of plain words under a control. */
const Note = styled.p`
  margin: var(--gap-xs) 0 0;
  color: var(--muted);
  font: 400 11px / 1.4 var(--font-ui);
`;

/** Shape: four segments in one row, one picked. */
const Shapes = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-bottom: var(--gap-s);

  button {
    height: 30px;
    padding: 0 4px;
    text-transform: none;
    letter-spacing: 0;
  }
`;

const SliderRow = styled.label`
  display: grid;
  grid-template-columns: 10ch 1fr 3ch;
  white-space: nowrap;
  align-items: center;
  gap: var(--gap-s);
  margin-top: var(--gap-xs);
  color: var(--muted);
  font: 500 12px / 1.3 var(--font-ui);

  input {
    min-width: 0;
    accent-color: var(--accent);
  }
  output {
    text-align: right;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
`;

/** An eye: the Look button's icon, drawn like the HUD's own icons. */
export function LookIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  );
}

const SHAPE_LABELS: Record<ScopeShape, { label: string; title: string }> = {
  circle: { label: "Circle", title: "A round, always clear window on the map" },
  oval: { label: "Oval", title: "A wide oval window" },
  rounded: { label: "Rounded", title: "A wide window with rounded corners" },
  frame: { label: "Frame", title: "The whole page is the clear window; only the soft edge fades" },
};
/** Size slider step, percent. */
export const SIZE_STEP = 5;

export const setLook = (id: LookId) => set<LookId>(LOOK, id);
export const setScopeShape = (shape: ScopeShape) => set<ScopeShape>(SCOPE_SHAPE, shapeOf(shape));
export const setScopeSize = (pct: number) => set<number>(SCOPE_SIZE, sizeOf(pct));
export const setScopeBlur = (px: number) => set<number>(SCOPE_BLUR, blurOf(px));
export const setScopeFeather = (pct: number) => set<number>(SCOPE_FEATHER, featherOf(pct));

/** Arrow keys move focus between the buttons of a group (`selector`); Enter and Space are the buttons' own. */
function arrowFocus(e: KeyboardEvent<HTMLDivElement>, selector: string): HTMLButtonElement | null {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const step = keys[e.key];
  if (step === undefined) return null;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(selector)];
  const at = buttons.findIndex((b) => b === document.activeElement);
  if (at < 0) return null;
  e.preventDefault();
  const next = buttons[(at + step + buttons.length) % buttons.length] ?? null;
  next?.focus();
  return next;
}

export type LookChoicesProps = {
  look: LookId;
  shape: ScopeShape;
  size: number;
  feather: number;
  /** The edge blur, px; the slider shows only with `onBlur`. */
  blur?: number;
  onLook: (id: LookId) => void;
  onShape: (shape: ScopeShape) => void;
  onSize: (pct: number) => void;
  onFeather: (pct: number) => void;
  onBlur?: (px: number) => void;
};

/** The popover's body over plain props, so it renders anywhere (tests included). */
export function LookChoices({ look, shape, size, feather, blur = DEFAULT_SCOPE_BLUR, onLook, onShape, onSize, onFeather, onBlur }: LookChoicesProps) {
  const ids = useId();
  return (
    <>
      <Heading>Look</Heading>
      <Presets role="group" aria-label="Visual preset" onKeyDown={(e) => arrowFocus(e, "button[data-look]")}>
        {LOOK_PRESETS.map((p) => (
          <IconButton key={p.id} type="button" $active={look === p.id} aria-pressed={look === p.id} aria-label={p.label} title={p.blurb} data-look={p.id} onClick={() => onLook(p.id)}>
            {p.label}
          </IconButton>
        ))}
      </Presets>
      <Heading>Map window</Heading>
      <Shapes
        role="radiogroup"
        aria-label="Window shape"
        data-testid="scope-shape"
        onKeyDown={(e) => {
          // A radio group: the arrows move and pick together.
          const next = arrowFocus(e, "button[data-shape]");
          if (next?.dataset.shape) onShape(shapeOf(next.dataset.shape));
        }}
      >
        {SCOPE_SHAPES.map((s) => (
          <IconButton
            key={s}
            type="button"
            role="radio"
            aria-checked={shape === s}
            tabIndex={shape === s ? 0 : -1}
            $active={shape === s}
            title={SHAPE_LABELS[s].title}
            data-shape={s}
            onClick={() => onShape(s)}
          >
            {SHAPE_LABELS[s].label}
          </IconButton>
        ))}
      </Shapes>
      <SliderRow htmlFor={`${ids}-size`}>
        Size
        <input
          id={`${ids}-size`}
          type="range"
          min={MIN_SCOPE_SIZE}
          max={MAX_SCOPE_SIZE}
          step={SIZE_STEP}
          value={size}
          aria-label="Window size"
          aria-valuetext={`${size} percent`}
          data-testid="scope-size"
          onChange={(e) => onSize(Number(e.currentTarget.value))}
        />
        <output aria-hidden="true">{size}</output>
      </SliderRow>
      <SliderRow htmlFor={`${ids}-feather`}>
        Soft edge
        <input
          id={`${ids}-feather`}
          type="range"
          min={0}
          max={MAX_SCOPE_FEATHER}
          step={1}
          value={feather}
          aria-label="Window soft edge"
          aria-valuetext={feather === 0 ? "0, sharp edge" : feather === MAX_SCOPE_FEATHER ? "100, no vignette" : `${feather}, fades out past the window`}
          data-testid="scope-feather"
          onChange={(e) => onFeather(Number(e.currentTarget.value))}
        />
        <output aria-hidden="true">{feather}</output>
      </SliderRow>
      {onBlur ? (
        <SliderRow htmlFor={`${ids}-blur`}>
          Edge blur
          <input
            id={`${ids}-blur`}
            type="range"
            min={0}
            max={MAX_SCOPE_BLUR}
            step={1}
            value={blur}
            aria-label="Window edge blur"
            aria-valuetext={blur === 0 ? "0, no blur" : `${blur} pixels at the rim`}
            data-testid="scope-blur"
            onChange={(e) => onBlur(Number(e.currentTarget.value))}
          />
          <output aria-hidden="true">{blur}</output>
        </SliderRow>
      ) : null}
      <Note>The window is always clear. Soft edge fades the map out past it: sharp at 0, no vignette at 100. Edge blur softens the fade, from nothing at the window to full at the rim.</Note>
    </>
  );
}
