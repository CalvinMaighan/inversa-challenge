"use client";

import { useEffect, useId, useRef } from "react";
import { get, set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { setFishRange } from "client/carp/fish";
import { DEFAULT_RANGE_DAYS, RANGE_DAYS, RANGE_OPTIONS, rangeLabel } from "client/state/range";
import { TIME, timeWindow, type TimeState } from "client/state/time";
import styled from "client/styled";

import { Surface } from "../primitives";
import { PopoverBox, usePopover } from "../topbar/TopBar";

const DAY_MS = 86_400_000;

const Anchor = styled.div`
  position: relative;
  flex: none;
`;

/** The top-row pill, like the species chips beside it: a calendar mark and the chosen period. */
const Trigger = styled(Surface.withComponent("button"))`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px 0 11px;
  border-radius: 18px;
  color: var(--text);
  font: 600 12.5px / 1 var(--font-ui);
  white-space: nowrap;
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
  }
  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--hud-line);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;

  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-m);
    width: 100%;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    background: none;
    color: var(--text);
    font: 600 13px / 1.2 var(--font-ui);
    text-align: left;
    cursor: pointer;
  }
  button:hover {
    background: color-mix(in oklab, var(--accent) 8%, transparent);
  }
  button[aria-checked="true"] {
    border-color: color-mix(in oklab, var(--accent) 55%, var(--border));
    background: color-mix(in oklab, var(--accent) 12%, transparent);
  }
  small {
    color: var(--muted);
    font: 400 12px / 1 var(--font-ui);
  }
`;

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" />
    </svg>
  );
}

/** Put every timeline on the last `days` days: python and lionfish's TIME window, carp's sightings range. */
function applyRange(days: number): void {
  const now = Date.now();
  set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, ...timeWindow(now, days), playing: false }));
  setFishRange(now - days * DAY_MS, now, now);
}

/** Puts the timelines on RANGE_DAYS when the HUD mounts, if one is not already on it (a choice applies itself when made). */
function useRangeSync(): void {
  useEffect(() => {
    const days = get<number>(RANGE_DAYS) ?? DEFAULT_RANGE_DAYS;
    const time = get<TimeState>(TIME);
    const span = time ? Date.parse(time.to) - Date.parse(time.from) : 0;
    if (Math.abs(span - days * DAY_MS) > DAY_MS) applyRange(days);
    // Carp's sightings window starts as two years: put it on the chosen period too.
    else setFishRange(Date.now() - days * DAY_MS, Date.now());
  }, []);
}

/** "1 year", at the top left beside the species: a popover with the periods to choose from (30 days to 2 years). */
export default function RangeButton() {
  useRangeSync();
  const days = useActiveState<number>(RANGE_DAYS)[0] ?? DEFAULT_RANGE_DAYS;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef);
  const id = useId();
  return (
    <Anchor>
      <Trigger
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label={`Period: ${rangeLabel(days)}. Change it`}
        title="How far back the timeline goes"
        data-testid="range-button"
        onClick={pop.toggle}
      >
        <CalendarIcon />
        {rangeLabel(days)}
      </Trigger>
      {pop.open ? (
        <PopoverBox id={id} label="Timeline period" testId="range-popover" popRef={popRef} onClose={pop.close} align="left">
          <List role="radiogroup" aria-label="Timeline period">
            {RANGE_OPTIONS.map((o) => (
              <li key={o.days}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={o.days === days}
                  data-range={o.days}
                  onClick={() => {
                    set(RANGE_DAYS, o.days);
                    applyRange(o.days);
                    pop.close();
                  }}
                >
                  {o.label}
                  <small>{o.days === DEFAULT_RANGE_DAYS ? "default" : ""}</small>
                </button>
              </li>
            ))}
          </List>
        </PopoverBox>
      ) : null}
    </Anchor>
  );
}
