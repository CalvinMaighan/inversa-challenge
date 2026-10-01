"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { LOOK_PRESETS } from "client/globe/look/presets";
import { featherOf, LOOK, lookOf, MAX_SCOPE_FEATHER, SCOPE_FEATHER, SCOPE_ON, scopeOnOf, type LookId } from "client/state/look";
import styled from "client/styled";

import { IconButton, Surface } from "../primitives";
import { usePopover } from "../topbar/TopBar";

/**
 * The "Look" control (docs/GODS_EYE.md GC2): one round button at the bottom centre of the globe pane, above the
 * timeline, with a popover holding the seven presets, the scope switch and the feather slider. It sits in GE1's
 * bottom bar (client/hud/shell/BottomBar.tsx) beside Layers; the bar places it, this wrapper anchors the popover.
 */
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

export const Popover = styled.div`
  position: absolute;
  pointer-events: auto;
  bottom: calc(100% + 8px);
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

const FeatherRow = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  color: var(--muted);
  font: 500 12px / 1.3 var(--font-ui);

  input {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
  }
  output {
    width: 3ch;
    text-align: right;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
`;

function LookIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  );
}

export const setLook = (id: LookId) => set<LookId>(LOOK, id);
export const setScopeOn = (on: boolean) => set<boolean>(SCOPE_ON, on);
export const setScopeFeather = (pct: number) => set<number>(SCOPE_FEATHER, featherOf(pct));

/** The popover's body over plain props, so it renders anywhere (tests included). */
export function LookChoices({
  look,
  scopeOn,
  feather,
  onLook,
  onScope,
  onFeather,
}: {
  look: LookId;
  scopeOn: boolean;
  feather: number;
  onLook: (id: LookId) => void;
  onScope: (on: boolean) => void;
  onFeather: (pct: number) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const featherId = useId();
  // Arrow keys move between the preset buttons (a toolbar); Enter and Space are the buttons' own.
  const onPresetKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const step = keys[e.key];
    if (step === undefined) return;
    const buttons = [...(groupRef.current?.querySelectorAll<HTMLButtonElement>("button[data-look]") ?? [])];
    const at = buttons.findIndex((b) => b === document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  return (
    <>
      <h3>Look</h3>
      <Presets ref={groupRef} role="group" aria-label="Visual preset" onKeyDown={onPresetKey}>
        {LOOK_PRESETS.map((p) => (
          <IconButton key={p.id} type="button" $active={look === p.id} aria-pressed={look === p.id} aria-label={p.label} title={p.blurb} data-look={p.id} onClick={() => onLook(p.id)}>
            {p.label}
          </IconButton>
        ))}
      </Presets>
      <ScopeRow>
        <span id={`${featherId}-scope`}>Scope: a round window on the map</span>
        <Switch type="button" role="switch" aria-checked={scopeOn} aria-labelledby={`${featherId}-scope`} data-testid="scope-switch" onClick={() => onScope(!scopeOn)} />
      </ScopeRow>
      <FeatherRow htmlFor={featherId}>
        Soft edge
        <input
          id={featherId}
          type="range"
          min={0}
          max={MAX_SCOPE_FEATHER}
          step={1}
          value={feather}
          disabled={!scopeOn}
          aria-label="Scope edge softness"
          data-testid="scope-feather"
          onChange={(e) => onFeather(Number(e.currentTarget.value))}
        />
        <output aria-hidden="true">{feather}</output>
      </FeatherRow>
    </>
  );
}

export default function LookBar() {
  const look = lookOf(useActiveState<LookId>(LOOK)[0]);
  const scopeOn = scopeOnOf(useActiveState<boolean>(SCOPE_ON)[0]);
  const feather = featherOf(useActiveState<number>(SCOPE_FEATHER)[0]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef);
  const id = useId();
  const label = LOOK_PRESETS.find((p) => p.id === look)?.label ?? "Normal";
  return (
    <Bar data-testid="look-bar">
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label={`Look: ${label}. Visual presets and the scope`}
        title="Look: visual presets and the scope"
        data-testid="look-button"
        onClick={pop.toggle}
      >
        <LookIcon />
        {label}
      </Round>
      {pop.open ? (
        <Popover
          ref={popRef}
          id={id}
          role="dialog"
          aria-label="Look"
          tabIndex={-1}
          data-testid="look-popover"
          data-hud-obstacle=""
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              pop.close();
            }
          }}
        >
          <LookChoices look={look} scopeOn={scopeOn} feather={feather} onLook={setLook} onScope={setScopeOn} onFeather={setScopeFeather} />
        </Popover>
      ) : null}
    </Bar>
  );
}
