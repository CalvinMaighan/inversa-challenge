"use client";

import { useActiveState } from "@calvinjs/active-state/react";

import { Surface } from "client/hud/primitives";
import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import styled from "client/styled";
import { LAYER_IDS, type AppConfig } from "shared/apps";

import { useSummary } from "./store";

const [SIGHTINGS] = LAYER_IDS;

const Chip = styled(Surface.withComponent("button"))`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-m);
  font: 600 12.5px / 1 var(--font-ui);
  cursor: pointer;
  i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--lf-color);
    box-shadow: 0 0 6px var(--lf-color);
  }
  &[aria-pressed="false"] i {
    background: transparent;
    border: 1.5px solid var(--lf-color);
    box-shadow: none;
  }
  small {
    color: var(--muted);
    font-weight: 500;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/** The species bar of a one-species survey app: one chip that shows or hides the reports, with their count. */
export default function LionfishChip({ app }: { app: AppConfig }) {
  const taxon = app.taxa[0];
  const s = useSummary();
  const on = (useActiveState<LayersState, boolean>(LAYERS, (l) => l.visible.sightings !== false)[0] ?? true) as boolean;
  const count = s.independent === null ? "…" : `${s.independent} report${s.independent === 1 ? "" : "s"}`;
  return (
    <Chip
      type="button"
      data-testid="lionfish-chip"
      aria-pressed={on}
      aria-label={`${taxon?.name ?? app.name}: ${count} ${s.basis} in the selected period. ${on ? "Hide" : "Show"} reports`}
      style={{ ["--lf-color" as string]: taxon?.color ?? "#a06cd5" }}
      onClick={() => setLayerVisible(SIGHTINGS, !on)}
    >
      <i aria-hidden="true" />
      {taxon?.short ?? taxon?.name ?? app.name}
      <small>{count}</small>
    </Chip>
  );
}
