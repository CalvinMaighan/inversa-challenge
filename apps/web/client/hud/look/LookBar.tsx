"use client";

import { useId, type KeyboardEvent } from "react";
import { set } from "@calvinjs/active-state";

import { LOOK_PRESETS } from "client/globe/look/presets";
import {
  featherOf,
  LOOK,
  MAX_SCOPE_FEATHER,
  MAX_SCOPE_SIZE,
  MIN_SCOPE_SIZE,
  SCOPE_FEATHER,
  SCOPE_ON,
  SCOPE_SHAPE,
  SCOPE_SHAPES,
  SCOPE_SIZE,
  shapeOf,
  sizeOf,
  type LookId,
  type ScopeShape,
} from "client/state/look";
import styled from "client/styled";

import { IconButton, Surface } from "../primitives";

/**
 * The Look controls (docs/GODS_EYE.md GC2, GE9): the seven presets and the map window (on or off, its shape, its
 * size and its soft edge). The button that opens them is an icon in the top-right cluster (client/hud/topbar,
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
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text);
  font: 400 13px / 1.45 var(--font-ui);

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

const ScopeRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  margin-bottom: var(--gap-s);

  span {
    flex: 1;
    font: 600 12px / 1.3 var(--font-ui);
  }
`;

const Switch = styled.button`
  position: relative;
  width: 34px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2, transparent);
  cursor: pointer;

  &::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--muted);
    transition: transform 120ms ease-out;
  }

  &[aria-checked="true"] {
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 35%, transparent);
  }
  &[aria-checked="true"]::after {
    background: var(--text);
    transform: translateX(14px);
  }
  @media (prefers-reduced-motion: reduce) {
    &::after {
      transition: none;
    }
  }
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
  circle: { label: "Circle", title: "A round window on the map" },
  oval: { label: "Oval", title: "A wide oval window" },
  rounded: { label: "Rounded", title: "A wide window with rounded corners" },
  frame: { label: "Frame", title: "The whole page, with only the soft edge" },
};
/** Size slider step, percent. */
export const SIZE_STEP = 5;

export const setLook = (id: LookId) => set<LookId>(LOOK, id);
export const setScopeOn = (on: boolean) => set<boolean>(SCOPE_ON, on);
export const setScopeShape = (shape: ScopeShape) => set<ScopeShape>(SCOPE_SHAPE, shapeOf(shape));
export const setScopeSize = (pct: number) => set<number>(SCOPE_SIZE, sizeOf(pct));
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
  scopeOn: boolean;
  shape: ScopeShape;
  size: number;
  feather: number;
  onLook: (id: LookId) => void;
  onScope: (on: boolean) => void;
  onShape: (shape: ScopeShape) => void;
  onSize: (pct: number) => void;
  onFeather: (pct: number) => void;
};

/** The popover's body over plain props, so it renders anywhere (tests included). */
export function LookChoices({ look, scopeOn, shape, size, feather, onLook, onScope, onShape, onSize, onFeather }: LookChoicesProps) {
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
      <ScopeRow>
        <span id={`${ids}-scope`}>Show the map through a window</span>
        <Switch type="button" role="switch" aria-checked={scopeOn} aria-labelledby={`${ids}-scope`} data-testid="scope-switch" onClick={() => onScope(!scopeOn)} />
      </ScopeRow>
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
            disabled={!scopeOn}
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
          disabled={!scopeOn}
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
          disabled={!scopeOn}
          aria-label="Window edge softness"
          data-testid="scope-feather"
          onChange={(e) => onFeather(Number(e.currentTarget.value))}
        />
        <output aria-hidden="true">{feather}</output>
      </SliderRow>
    </>
  );
}
