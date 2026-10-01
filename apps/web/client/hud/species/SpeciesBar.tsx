"use client";

import { useId, useMemo } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { LAYERS, setSpeciesVisible, sightingHoursOf, type LayersState } from "client/state/layers";
import styled from "client/styled";
import { hasLayer } from "shared/apps";
import { windowLabel } from "shared/frames";
import { LAYER_IDS } from "shared/voice/ui-tools";

import AppIcon from "../appselect/AppIcon";
import { useActiveApp } from "../appselect/use-active-app";
import { formatCount } from "../legend/model";
import { useGlobeStats } from "../legend/useGlobeStats";
import { MOBILE, Mono, Surface } from "../primitives";
import { speciesChip, type ChipModel } from "./model";

const [SIGHTINGS] = LAYER_IDS;

const Bar = styled(Surface)`
  display: flex;
  align-items: center;
  padding: 4px;
  border-radius: var(--radius-m);
  min-width: 0;
  max-width: 100%;

  ${MOBILE} {
    padding: 3px;
  }
`;

const Slot = styled.span`
  position: relative;
  display: inline-flex;

  /* The plain one-line description: on hover and keyboard focus. */
  [role="tooltip"] {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 6;
    width: max-content;
    max-width: min(300px, 70cqw);
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 400 12px / 1.35 var(--font-ui);
    visibility: hidden;
    pointer-events: none;
  }

  &:hover [role="tooltip"],
  &:focus-within [role="tooltip"] {
    visibility: visible;
  }
`;

const Chip = styled.button<{ $color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px 0 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--muted);
  font: 600 12.5px / 1 var(--font-ui);
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  max-width: 190px;

  svg {
    opacity: 0.55;
  }

  span.name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &[aria-pressed="true"] {
    color: var(--text);
    border-color: var(--border);
    background: color-mix(in oklch, ${(p) => p.$color} 16%, transparent);
    svg {
      opacity: 1;
    }
  }

  &[data-empty] {
    opacity: 0.55;
  }

  &:hover {
    color: var(--text);
    border-color: var(--hud-line);
  }

  ${MOBILE} {
    height: 28px;
    padding: 0 6px 0 5px;
    gap: 4px;
    font-size: 12px;
    max-width: 150px;
  }
`;

const Count = styled(Mono)`
  color: var(--muted);
  font-size: 11px;
`;

function SpeciesChip({ chip, hours }: { chip: ChipModel; hours: number }) {
  const tipId = useId();
  return (
    <Slot>
      <Chip
        type="button"
        $color={chip.color}
        aria-pressed={chip.on}
        aria-describedby={tipId}
        data-species-chip={chip.key}
        data-empty={chip.count === 0 ? "" : undefined}
        onClick={() => setSpeciesVisible(chip.key, !chip.on)}
      >
        <AppIcon icon={chip.icon} color={chip.color} size={18} />
        <span className="name">{chip.name}</span>
        <Count data-species-count="">{formatCount(chip.count)}</Count>
      </Chip>
      <span role="tooltip" id={tipId}>
        <b>{chip.full}</b>: {chip.line.replace(/\.$/, "")}. {formatCount(chip.count)} seen in the last {windowLabel(hours)}. Click to show or hide them.
      </span>
    </Slot>
  );
}

/**
 * Species chip (T41), top left of the map: the app's one species with its icon in its colour and how many
 * sightings there are in the window (GlobeApi stats breakdown, counted whatever the filter). Click shows or hides
 * its markers. It writes the LAYERS species filter, which the globe, the legend, the timeline sparkline and the
 * agent's view all read.
 */
export default function SpeciesBar() {
  // An app without sightings (carp: gauges and alerts) has no species to filter.
  return hasLayer(useActiveApp(), SIGHTINGS) ? <SpeciesBarBody /> : null;
}

function SpeciesBarBody() {
  const layers = useActiveState<LayersState>(LAYERS)[0];
  const filter = layers?.species ?? LAYERS.defaults.species;
  const hours = sightingHoursOf(layers);
  const stats = useGlobeStats();
  const breakdown = stats?.find((s) => s.id === SIGHTINGS)?.breakdown ?? null;
  const chip = useMemo(() => speciesChip(filter, breakdown), [filter, breakdown]);
  if (!chip) return null;
  return (
    <Bar role="group" aria-label="Species filter" data-hud-obstacle="" data-testid="species-bar">
      <SpeciesChip chip={chip} hours={hours} />
    </Bar>
  );
}
