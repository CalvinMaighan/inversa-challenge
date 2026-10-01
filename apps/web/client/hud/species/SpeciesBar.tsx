"use client";

import { useId, useRef, useState, type PointerEvent } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { OTHER_TAXON_COLOR, SPECIES_COLORS } from "client/globe/species";
import { LAYERS, setSpeciesVisible, showAllSpecies, showOnlySpecies, SPECIES_FILTER_IDS, type LayersState, type SpeciesFilterId } from "client/state/layers";
import styled from "client/styled";
import { SIGHTING_WINDOW_HOURS } from "shared/frames";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { SPECIES_GUIDE } from "../help/content";
import { formatCount } from "../legend/model";
import { useGlobeStats } from "../legend/useGlobeStats";
import { MOBILE, Mono, Surface } from "../primitives";

/** Chip colours, indexed like SPECIES_FILTER_IDS: the globe's species colours, then other taxa. */
export const SPECIES_CHIP_COLORS: readonly string[] = [...SPECIES_COLORS, OTHER_TAXON_COLOR];
const [SIGHTINGS] = LAYER_IDS;
/** A touch held this long shows only that species. */
const LONG_PRESS_MS = 500;

const Bar = styled(Surface)`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: var(--radius-m);
  min-width: 0;

  ${MOBILE} {
    gap: 2px;
    padding: 3px;
  }
`;

const Slot = styled.span`
  position: relative;
  display: inline-flex;

  /* The plain one-line description: on hover, keyboard focus and a held touch. */
  [role="tooltip"] {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 6;
    width: max-content;
    max-width: min(260px, 70cqw);
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
  &:focus-within [role="tooltip"],
  &[data-pressing] [role="tooltip"] {
    visibility: visible;
  }
`;

const Chip = styled.button<{ $color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--muted);
  font: 600 12.5px / 1 var(--font-ui);
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-touch-callout: none;

  i {
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid ${(p) => p.$color};
    background: transparent;
  }

  &[aria-pressed="true"] {
    color: var(--text);
    border-color: var(--border);
    background: color-mix(in oklch, ${(p) => p.$color} 16%, transparent);
    i {
      background: ${(p) => p.$color};
      border: 1.5px solid #0b0d12;
    }
  }

  &:hover {
    color: var(--text);
    border-color: var(--hud-line);
  }

  ${MOBILE} {
    height: 28px;
    padding: 0 6px;
    gap: 4px;
    font-size: 12px;
  }
`;

const Count = styled(Mono)`
  color: var(--muted);
  font-size: 11px;
`;

const All = styled.button`
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 12px / 1 var(--font-ui);
  cursor: pointer;

  ${MOBILE} {
    height: 28px;
  }
`;

function SpeciesChip({ id, index, on, count }: { id: SpeciesFilterId; index: number; on: boolean; count: number | null }) {
  const guide = SPECIES_GUIDE[index]!;
  const tipId = useId();
  const [pressing, setPressing] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const cancel = () => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
    setPressing(false);
  };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    press.current.fired = false;
    if (e.pointerType !== "touch") return;
    cancel();
    setPressing(true);
    press.current.timer = setTimeout(() => {
      press.current.fired = true;
      showOnlySpecies(id);
    }, LONG_PRESS_MS);
  };
  return (
    <Slot data-pressing={pressing ? "" : undefined}>
      <Chip
        type="button"
        $color={SPECIES_CHIP_COLORS[index]!}
        aria-pressed={on}
        aria-describedby={tipId}
        data-species-chip={id}
        onPointerDown={onPointerDown}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => {
          if (press.current.timer !== null || press.current.fired) e.preventDefault();
        }}
        onClick={(e) => {
          if (press.current.fired) {
            press.current.fired = false;
            return;
          }
          if (e.altKey) showOnlySpecies(id);
          else setSpeciesVisible(id, !on);
        }}
      >
        <i aria-hidden="true" />
        {guide.name}
        <Count data-species-count="">{formatCount(count)}</Count>
      </Chip>
      <span role="tooltip" id={tipId}>
        <b>{guide.full}</b>: {guide.line}. {formatCount(count)} seen in the last {SIGHTING_WINDOW_HOURS} hours. Alt-click or hold to show only these.
      </span>
    </Slot>
  );
}

/**
 * Species filter bar (T41), top left of the map: a chip per focus species plus "Other", with its globe colour
 * and how many sightings there are in the last 48 hours (GlobeApi stats breakdown, counted whatever the filter).
 * Click toggles; Alt-click or a long press shows only that species; "All" resets. It writes the LAYERS species
 * filter, which the globe, the legend, the timeline sparkline and the agent's view all read.
 */
export default function SpeciesBar() {
  const filter = useActiveState<LayersState, LayersState["species"]>(LAYERS, (l) => l.species)[0] ?? LAYERS.defaults.species;
  const stats = useGlobeStats();
  const breakdown = stats?.find((s) => s.id === SIGHTINGS)?.breakdown ?? null;
  const filtered = SPECIES_FILTER_IDS.some((id) => filter[id] === false);
  return (
    <Bar role="group" aria-label="Species filter" data-hud-obstacle="" data-testid="species-bar">
      {SPECIES_FILTER_IDS.map((id, i) => (
        <SpeciesChip key={id} id={id} index={i} on={filter[id] !== false} count={breakdown ? (breakdown[id] ?? 0) : null} />
      ))}
      {filtered ? (
        <All type="button" onClick={showAllSpecies} data-testid="species-all" title="Show every species">
          All
        </All>
      ) : null}
    </Bar>
  );
}
