"use client";

import { useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { SPECIES_COLORS } from "client/globe/species";
import { isSpeciesFiltered, LAYERS, setSightingHours, setSpeciesVisible, setTaxonVisible, showAllSpecies, showOnlySpecies, showOnlyTaxon, sightingHoursOf, type LayersState } from "client/state/layers";
import { TAXA, type TaxaState } from "client/state/taxa";
import styled from "client/styled";
import { SIGHTING_WINDOW_OPTIONS, windowLabel } from "shared/frames";
import { CATEGORY_COLORS } from "shared/species-categories";
import { LAYER_IDS } from "shared/voice/ui-tools";

import { WINDOW_NOTE } from "../help/content";
import { formatCount } from "../legend/model";
import { useGlobeStats } from "../legend/useGlobeStats";
import { MOBILE, Mono, Surface } from "../primitives";
import { usePopover } from "../topbar/TopBar";
import CategoriesPopover from "./CategoriesPopover";
import CategoryIcon from "./CategoryIcon";
import { categoryRows, MOBILE_ANIMAL_CHIPS, speciesChips, type ChipModel } from "./model";

export { firstSentence, MOBILE_ANIMAL_CHIPS, speciesChips, TOP_ANIMAL_CHIPS, type ChipModel } from "./model";

/** Chip colours, indexed like SPECIES_GUIDE: the four focus colours, then the "Other" chip's neutral. */
export const SPECIES_CHIP_COLORS: readonly string[] = [...SPECIES_COLORS, CATEGORY_COLORS.other];
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
  max-width: min(100%, 760px);

  ${MOBILE} {
    gap: 2px;
    padding: 3px;
  }
`;

const Slot = styled.span`
  position: relative;
  display: inline-flex;

  /* A phone keeps the bar to two rows: the focus four, the top three other animals and Other. */
  ${MOBILE} {
    &[data-extra] {
      display: none;
    }
  }

  /* The plain one-line description: on hover, keyboard focus and a held touch. */
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
  padding: 0 9px 0 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--muted);
  font: 600 12.5px / 1 var(--font-ui);
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-touch-callout: none;
  max-width: 190px;

  svg {
    opacity: 0.55;
  }

  span.name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* On: a pressed chip, the Other chip while any category is on, and the Other chip while its popover is open. */
  &[aria-pressed="true"],
  &[data-on="true"],
  &[aria-expanded="true"] {
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

const Window = styled.select`
  height: 30px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 11.5px / 1 var(--font-ui);
  cursor: pointer;
  option {
    background: var(--surface);
  }

  ${MOBILE} {
    height: 28px;
  }
`;

function toggle(chip: ChipModel, only: boolean): void {
  if (chip.target.kind === "taxon") {
    if (only) showOnlyTaxon(chip.target.id);
    else setTaxonVisible(chip.target.id, !chip.on);
  } else if (chip.target.kind === "species") {
    if (only) showOnlySpecies(chip.target.id);
    else setSpeciesVisible(chip.target.id, !chip.on);
  }
}

function SpeciesChip({ chip, hours, onOpen, open, triggerRef, popId }: { chip: ChipModel; hours: number; onOpen?: () => void; open?: boolean; triggerRef?: React.RefObject<HTMLButtonElement | null>; popId?: string }) {
  const tipId = useId();
  const [pressing, setPressing] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const opens = chip.target.kind === "categories";
  const cancel = () => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
    setPressing(false);
  };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    press.current.fired = false;
    if (e.pointerType !== "touch" || opens) return;
    cancel();
    setPressing(true);
    press.current.timer = setTimeout(() => {
      press.current.fired = true;
      toggle(chip, true);
    }, LONG_PRESS_MS);
  };
  const seen = `${formatCount(chip.count)} seen in the last ${windowLabel(hours)}.`;
  return (
    <Slot data-pressing={pressing ? "" : undefined} data-extra={chip.rank !== undefined && chip.rank >= MOBILE_ANIMAL_CHIPS ? "" : undefined}>
      <Chip
        ref={triggerRef}
        type="button"
        $color={chip.color}
        aria-pressed={opens ? undefined : chip.on}
        aria-expanded={opens ? open : undefined}
        aria-haspopup={opens ? "dialog" : undefined}
        aria-controls={opens && open ? popId : undefined}
        aria-describedby={tipId}
        data-species-chip={chip.key}
        data-category={chip.category}
        data-on={opens ? (chip.on ? "true" : "false") : undefined}
        data-empty={chip.count === 0 ? "" : undefined}
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
          if (opens) onOpen?.();
          else toggle(chip, e.altKey);
        }}
      >
        <CategoryIcon category={chip.category} color={chip.color} size={18} />
        <span className="name">{chip.name}</span>
        <Count data-species-count="">{formatCount(chip.count)}</Count>
      </Chip>
      <span role="tooltip" id={tipId}>
        <b>{chip.full}</b>: {chip.line.replace(/\.$/, "")}. {seen} {opens ? "Click to pick which kinds show." : "Alt-click or hold to show only these."}
      </span>
    </Slot>
  );
}

/** The 2 / 7 / 30 day window, compact. */
function WindowSelect({ hours }: { hours: number }) {
  return (
    <Window
      value={hours}
      aria-label="Sightings window"
      title={WINDOW_NOTE}
      data-testid="sighting-window"
      onChange={(e) => {
        const next = Number(e.currentTarget.value);
        const option = SIGHTING_WINDOW_OPTIONS.find((h) => h === next);
        if (option) setSightingHours(option);
      }}
    >
      {SIGHTING_WINDOW_OPTIONS.map((h) => (
        <option key={h} value={h}>
          Last {windowLabel(h)}
        </option>
      ))}
    </Window>
  );
}

/**
 * Species filter bar (T41, T44), top left of the map: the four focus species pinned, then the most-seen other
 * animals of the window, then "Other", which opens every category (snakes, lizards, …, plants) with its icon,
 * colour, count and switch, and each category's top species. Every chip carries its category's icon in its
 * colour and how many sightings there are in the window (GlobeApi stats breakdown, counted whatever the filter),
 * plus the window selector. Click toggles; Alt-click or a long press shows only that species; "All" brings every
 * animal back. It writes the LAYERS species filter, which the globe, the legend, the timeline sparkline and the
 * agent's view all read.
 */
export default function SpeciesBar() {
  const layers = useActiveState<LayersState>(LAYERS)[0];
  const filter = layers?.species ?? LAYERS.defaults.species;
  const hours = sightingHoursOf(layers);
  const taxa = useActiveState<TaxaState, TaxaState["byId"]>(TAXA, (t) => t.byId)[0] ?? TAXA.defaults.byId;
  const stats = useGlobeStats();
  const breakdown = stats?.find((s) => s.id === SIGHTINGS)?.breakdown ?? null;
  const chips = useMemo(() => speciesChips(filter, taxa, breakdown), [filter, taxa, breakdown]);
  const rows = useMemo(() => categoryRows(filter, taxa, breakdown), [filter, taxa, breakdown]);
  const filtered = isSpeciesFiltered(filter);
  const otherRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const popId = useId();
  const popover = usePopover(otherRef, popRef);
  return (
    <Bar role="group" aria-label="Species filter" data-hud-obstacle="" data-testid="species-bar" style={{ position: "relative" }}>
      {chips.map((chip) =>
        chip.target.kind === "categories" ? (
          <SpeciesChip key={chip.key} chip={chip} hours={hours} onOpen={popover.toggle} open={popover.open} triggerRef={otherRef} popId={popId} />
        ) : (
          <SpeciesChip key={chip.key} chip={chip} hours={hours} />
        ),
      )}
      {filtered ? (
        <All type="button" onClick={showAllSpecies} data-testid="species-all" title="Show every animal again">
          All
        </All>
      ) : null}
      <WindowSelect hours={hours} />
      {popover.open ? <CategoriesPopover id={popId} rows={rows} hours={windowLabel(hours)} popRef={popRef} onClose={popover.close} /> : null}
    </Bar>
  );
}
