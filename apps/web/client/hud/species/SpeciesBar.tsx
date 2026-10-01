"use client";

import { useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { colorOfTaxon, groupShown, NEUTRAL_COLOR, SPECIES_COLORS, taxonShown } from "client/globe/species";
import {
  isSpeciesFiltered,
  LAYERS,
  setSightingHours,
  setSpeciesVisible,
  setTaxonVisible,
  showAllSpecies,
  showOnlySpecies,
  showOnlyTaxon,
  sightingHoursOf,
  SPECIES_GROUP_IDS,
  type LayersState,
  type SpeciesFilterId,
  type SpeciesGroupId,
} from "client/state/layers";
import { groupOf, isFocusTaxon, TAXA, taxonName, type TaxaState, type TaxonInfo } from "client/state/taxa";
import styled from "client/styled";
import { SIGHTING_WINDOW_OPTIONS, windowLabel } from "shared/frames";
import { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

import { GROUP_GUIDE, SPECIES_GUIDE, WINDOW_NOTE } from "../help/content";
import { formatCount } from "../legend/model";
import { useGlobeStats } from "../legend/useGlobeStats";
import { MOBILE, Mono, Surface } from "../primitives";

/** Chip colours, indexed like SPECIES_GUIDE: the four focus colours, then the neutral of a group chip. */
export const SPECIES_CHIP_COLORS: readonly string[] = [...SPECIES_COLORS, NEUTRAL_COLOR];
const [SIGHTINGS] = LAYER_IDS;
/** A touch held this long shows only that species. */
const LONG_PRESS_MS = 500;
/** Non-focus animal chips in the bar: the most-seen taxa of the window. */
export const TOP_ANIMAL_CHIPS = 6;

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
  max-width: 190px;

  i {
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid ${(p) => p.$color};
    background: transparent;
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
    i {
      background: ${(p) => p.$color};
      border: 1.5px solid #0b0d12;
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
    padding: 0 6px;
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

/** One chip of the bar: a focus species, a top animal, or a whole group. */
export type ChipModel = {
  /** `python`…`lionfish`, `animals|plants|others`, or `t<taxon id>`. */
  key: string;
  /** What the chip toggles. */
  target: { kind: "species"; id: SpeciesFilterId } | { kind: "taxon"; id: number };
  name: string;
  /** The description line under the name on hover. */
  full: string;
  line: string;
  color: string;
  on: boolean;
  count: number | null;
};

/** First sentence of a taxon summary, for the chip's one-line description. */
export function firstSentence(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  return (m ? m[1]! : t).trim();
}

/**
 * The bar's chips (T44): the four focus species pinned first, then the TOP_ANIMAL_CHIPS most-seen other animals
 * of the window (a hidden one stays listed while it has sightings, so it can be turned back on), then the
 * Plants and "Insects & others" group chips. Pure over the filter, the TAXA store and the layer breakdown
 * (counts per taxon id, before the filter).
 */
export function speciesChips(filter: LayersState["species"], taxa: Readonly<Record<string, TaxonInfo>>, breakdown: Readonly<Record<string, number>> | null): ChipModel[] {
  const count = (key: string) => (breakdown ? (breakdown[key] ?? 0) : null);
  const chips: ChipModel[] = SPECIES_IDS.map((id, i) => {
    const guide = SPECIES_GUIDE[i]!;
    return { key: id, target: { kind: "species", id }, name: guide.name, full: guide.full, line: guide.line, color: SPECIES_COLORS[i]!, on: filter[id] !== false, count: count(String(i + 1)) };
  });
  const totals: Record<SpeciesGroupId, number> = { animals: 0, plants: 0, others: 0 };
  const animals: { id: number; n: number; info: TaxonInfo | undefined }[] = [];
  for (const [key, n] of Object.entries(breakdown ?? {})) {
    const id = Number(key);
    if (!Number.isInteger(id) || isFocusTaxon(id)) continue;
    const info = taxa[key];
    const group = info ? groupOf(info.iconicGroup) : "animals";
    totals[group] += n;
    if (group === "animals" && n > 0) animals.push({ id, n, info });
  }
  animals.sort((a, b) => b.n - a.n || a.id - b.id);
  for (const { id, n, info } of animals.slice(0, TOP_ANIMAL_CHIPS)) {
    const name = taxonName(info, `Species ${id}`);
    chips.push({
      key: `t${id}`,
      target: { kind: "taxon", id },
      name,
      full: name,
      line: firstSentence(info?.summary) ?? (info?.scientificName ? `${info.scientificName}, an introduced species` : "an introduced animal people reported"),
      color: colorOfTaxon(id),
      on: taxonShown(filter, id, taxa, SIGHTINGS),
      count: breakdown ? n : null,
    });
  }
  for (const id of SPECIES_GROUP_IDS) {
    if (id === "animals") continue;
    const guide = GROUP_GUIDE[id];
    const on = groupShown(filter, id);
    chips.push({ key: id, target: { kind: "species", id }, name: guide.name, full: guide.full, line: guide.line, color: NEUTRAL_COLOR, on, count: breakdown ? totals[id] : null });
  }
  return chips;
}

function toggle(chip: ChipModel, only: boolean): void {
  if (chip.target.kind === "taxon") {
    if (only) showOnlyTaxon(chip.target.id);
    else setTaxonVisible(chip.target.id, !chip.on);
  } else if (only) showOnlySpecies(chip.target.id);
  else setSpeciesVisible(chip.target.id, !chip.on);
}

function SpeciesChip({ chip, hours }: { chip: ChipModel; hours: number }) {
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
      toggle(chip, true);
    }, LONG_PRESS_MS);
  };
  const seen = `${formatCount(chip.count)} seen in the last ${windowLabel(hours)}.`;
  return (
    <Slot data-pressing={pressing ? "" : undefined}>
      <Chip
        type="button"
        $color={chip.color}
        aria-pressed={chip.on}
        aria-describedby={tipId}
        data-species-chip={chip.key}
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
          toggle(chip, e.altKey);
        }}
      >
        <i aria-hidden="true" />
        <span className="name">{chip.name}</span>
        <Count data-species-count="">{formatCount(chip.count)}</Count>
      </Chip>
      <span role="tooltip" id={tipId}>
        <b>{chip.full}</b>: {chip.line.replace(/\.$/, "")}. {seen} Alt-click or hold to show only these.
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
 * animals of the window, then Plants and "Insects & others" (off by default), each chip with its globe colour
 * and how many sightings there are in the window (GlobeApi stats breakdown, counted whatever the filter), plus
 * the window selector. Click toggles; Alt-click or a long press shows only that species; "All" brings every
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
  const filtered = isSpeciesFiltered(filter);
  return (
    <Bar role="group" aria-label="Species filter" data-hud-obstacle="" data-testid="species-bar">
      {chips.map((chip) => (
        <SpeciesChip key={chip.key} chip={chip} hours={hours} />
      ))}
      {filtered ? (
        <All type="button" onClick={showAllSpecies} data-testid="species-all" title="Show every animal again">
          All
        </All>
      ) : null}
      <WindowSelect hours={hours} />
    </Bar>
  );
}
