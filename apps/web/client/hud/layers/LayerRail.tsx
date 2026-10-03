"use client";

import { useMemo, type ReactNode } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { setFishVisible, useFish } from "client/carp/fish";
import { overlayRows } from "client/globe/layers/overlays/legend";
import { isSurveyApp } from "client/lionfish/model";
import { setView, useView } from "client/lionfish/store";
import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import styled from "client/styled";
import { hasLayer, LAYER_IDS, type AppConfig } from "shared/apps";

import { useActiveApp } from "../appselect/use-active-app";
import { Surface } from "../primitives";
import { STRIP_HEIGHT_PX } from "../zoom/strip";

const SIGHTINGS = LAYER_IDS[0];
const SST_MAP = LAYER_IDS[10];
/** Height of the Layers and Search pills (client/hud/shell/BottomBar.tsx). */
const BAR_PX = 32;

/**
 * The layer buttons, a column right above the Layers button: one round icon for every layer the app can show (sightings, the
 * reef heat map on lionfish, the water and weather pictures), the icon in the accent colour while the layer is on. A click
 * switches the layer, nothing opens. The Layers panel keeps the same switches with their notes and legends.
 */
const Rail = styled.div`
  position: absolute;
  z-index: 3;
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: calc(max(var(--gap-m), env(safe-area-inset-bottom)) + ${STRIP_HEIGHT_PX}px + var(--gap-m) + ${BAR_PX}px + var(--gap-s));
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: var(--gap-s);
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
`;

const Button = styled(Surface.withComponent("button"))`
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  color: var(--muted);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;

  svg {
    width: 17px;
    height: 17px;
  }

  &:hover {
    color: var(--text);
    border-color: var(--hud-line);
  }
  &[aria-pressed="true"] {
    color: var(--accent);
    border-color: color-mix(in oklch, var(--accent) 55%, var(--border));
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** One small drawing per layer, by layer id (the reef heat map is `reef`). */
const ICONS: Record<string, ReactNode> = {
  [SIGHTINGS]: (
    <Icon>
      <path d="M8 14s4.5-3.9 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10.1 8 14 8 14Z" />
      <circle cx="8" cy="6.5" r="1.6" />
    </Icon>
  ),
  reef: (
    <Icon>
      <path d="M2 11c1.5-1.4 3-1.4 4.5 0S9.5 12.4 11 11s3-1.4 3 0" />
      <path d="M5 8.5V4M8 8V2.5M11 8.5V5" />
    </Icon>
  ),
  [SST_MAP]: (
    <Icon>
      <path d="M7 2.5a1.5 1.5 0 0 1 3 0V9a3 3 0 1 1-3 0Z" transform="translate(-1.5 0)" />
      <path d="M12 4h2M12 7h2M12 10h2" />
    </Icon>
  ),
  radar: (
    <Icon>
      <path d="M4.5 10.5a3 3 0 0 1 .4-5.9 3.8 3.8 0 0 1 7.2 1.4 2.4 2.4 0 0 1-.5 4.5Z" />
      <path d="M6 13l.6-1.4M9 13l.6-1.4" />
    </Icon>
  ),
  lightning: (
    <Icon>
      <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z" />
    </Icon>
  ),
  cyclones: (
    <Icon>
      <path d="M8 8.2a.4.4 0 1 1 .01 0M8 5a3 3 0 0 1 3 3 4.6 4.6 0 0 1-4.6 4.6A5.8 5.8 0 0 1 2 8 6 6 0 0 1 8 2" />
    </Icon>
  ),
};

export type RailLayer = { id: string; label: string; on: boolean; toggle: () => void };

/**
 * Every layer the app can switch from here, in the Layers panel's order (sightings, the reef heat map, then the water and
 * weather pictures), each with whether it is on and what a click does. Carp's sightings are the fish dots.
 */
export function railLayers(app: AppConfig, layers: LayersState, reef: { heat: boolean }, fishOn: boolean): RailLayer[] {
  const out: RailLayer[] = [];
  if (hasLayer(app, SIGHTINGS)) {
    const on = layers.visible[SIGHTINGS] !== false;
    out.push({ id: SIGHTINGS, label: "Sightings", on, toggle: () => setLayerVisible(SIGHTINGS, !on) });
  } else if (app.kind === "conditions") {
    out.push({ id: SIGHTINGS, label: "Sightings", on: fishOn, toggle: () => setFishVisible(!fishOn) });
  }
  if (isSurveyApp(app)) out.push({ id: "reef", label: "Reef heat map", on: reef.heat, toggle: () => setView({ heat: !reef.heat }) });
  for (const row of overlayRows(app, layers, null)) out.push({ id: row.id, label: row.label, on: row.visible, toggle: () => setLayerVisible(row.id, !row.visible) });
  return out;
}

/** The rail itself. */
export default function LayerRail() {
  const app = useActiveApp();
  const stored = useActiveState<LayersState>(LAYERS)[0];
  const layers = useMemo(() => ({ ...LAYERS.defaults, ...stored }), [stored]);
  const view = useView();
  const fish = useFish();
  const rail = railLayers(app, layers, { heat: view.heat }, fish.visible);
  if (rail.length === 0) return null;
  return (
    <Rail data-testid="layer-rail" role="group" aria-label="Layers">
      {rail.map((l) => (
        <Button key={l.id} type="button" aria-pressed={l.on} aria-label={`${l.label}: ${l.on ? "on" : "off"}`} title={`${l.label}: ${l.on ? "on, click to hide" : "off, click to show"}`} data-rail-layer={l.id} onClick={l.toggle}>
          {ICONS[l.id]}
        </Button>
      ))}
    </Rail>
  );
}
