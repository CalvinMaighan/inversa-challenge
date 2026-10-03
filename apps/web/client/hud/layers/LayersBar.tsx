"use client";

import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import ReefLayerRow from "client/lionfish/ReefControls";
import { isSurveyApp } from "client/lionfish/model";
import { LAYERS, type LayersState } from "client/state/layers";
import styled from "client/styled";
import type { AppConfig } from "shared/apps";

import { useActiveApp } from "../appselect/use-active-app";
import { GroupHead, LegendRowView } from "../legend/LegendPanel";
import { useGlobeStats } from "../legend/useGlobeStats";
import WaterWeather from "../legend/WaterWeather";
import { Bar, Popover, Round } from "../look/LookBar";
import { usePopover } from "../topbar/TopBar";
import { layersGroups } from "./model";

/**
 * "Layers" (docs/GODS_EYE.md GC1, GC6; GE7): the round button beside Look in the bottom bar. Its popover is what a
 * newcomer may put on the map, grouped, one plain line each: sightings and field notes (on at first load), Ships
 * for carp and lionfish, and Water and weather. The rows are the legend's own (`LegendRowView`, `WaterWeather`)
 * over LAYERS, so a switch here, in the expert legend or from the agent is the same switch. Tab walks the
 * switches, Space flips one, Esc closes and returns focus to the button.
 */
const Pop = styled(Popover)`
  width: min(340px, calc(100cqw - 2 * var(--gap-m)));
  max-height: calc(100cqh - var(--hud-top) - var(--hud-bottom) - 64px);
  overflow: auto;
  overscroll-behavior: contain;

  > section:first-of-type > h3:first-child,
  > h3:first-child {
    margin-top: 0;
  }
`;

const Group = styled.section`
  & + & {
    margin-top: var(--gap-s);
  }
`;

function LayersIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 14.5 5 8 8.2 1.5 5z" />
      <path d="m1.5 8 6.5 3.2L14.5 8" />
      <path d="m1.5 11 6.5 3.2 6.5-3.2" />
    </svg>
  );
}

/** The popover's body for one app, over plain props (markup tests render it without a globe). */
export function LayersChoices({ app, layers, active }: { app: AppConfig; layers: LayersState; active: boolean }) {
  const stats = useGlobeStats(active);
  const groups = useMemo(() => layersGroups(layers, stats, app), [app, layers, stats]);
  return (
    <>
      <h3>Layers</h3>
      {groups.map((g) => (
        <Group key={g.id} aria-label={g.label} data-testid={`layers-group-${g.id}`}>
          <GroupHead data-testid={`legend-group-${g.id}`}>{g.label}</GroupHead>
          {g.rows.map((row) => (
            <LegendRowView key={row.layer} row={row} />
          ))}
        </Group>
      ))}
      {isSurveyApp(app) ? (
        <Group aria-label="Reef" data-testid="layers-group-reef">
          <GroupHead>Reef</GroupHead>
          <ReefLayerRow />
        </Group>
      ) : null}
      <WaterWeather app={app} active={active} />
    </>
  );
}

export default function LayersBar() {
  const app = useActiveApp();
  const stored = useActiveState<LayersState>(LAYERS)[0];
  const layers = useMemo(() => ({ ...LAYERS.defaults, ...stored }), [stored]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef, "layers");
  const id = useId();
  const barRef = useRef<HTMLDivElement>(null);

  // The popover's right edge sits one gutter from the page's right edge, whatever the pill's own place is.
  useLayoutEffect(() => {
    if (!pop.open) return;
    const place = () => {
      const el = popRef.current;
      const bar = barRef.current;
      if (!el || !bar) return;
      const pageRight = document.querySelector('[data-slot="hud"]')?.getBoundingClientRect().right ?? window.innerWidth;
      const gap = Number.parseFloat(getComputedStyle(el).getPropertyValue("--gap-m")) || 12;
      el.style.left = "auto";
      el.style.transform = "none";
      el.style.right = `${bar.getBoundingClientRect().right - (pageRight - gap)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [pop.open]);

  return (
    <Bar ref={barRef} data-testid="layers-bar">
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label="Layers: what the map shows"
        title="Layers: what the map shows"
        data-testid="layers-bar-button"
        onClick={pop.toggle}
      >
        <LayersIcon />
        Layers
      </Round>
      {pop.open ? (
        <Pop
          ref={popRef}
          id={id}
          role="dialog"
          aria-label="Layers"
          tabIndex={-1}
          data-testid="layers-popover"
          data-app={app.id}
          data-hud-obstacle=""
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              pop.close();
            }
          }}
        >
          <LayersChoices app={app} layers={layers} active />
        </Pop>
      ) : null}
    </Bar>
  );
}
