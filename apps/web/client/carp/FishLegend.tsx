"use client";

import { useMemo } from "react";

import { Surface } from "client/hud/primitives";
import styled from "client/styled";

import { SPECIES_COLORS, toggleSpecies, useFish } from "./fish";

/** The species, one group in the top row after Ships: each a switch with its colour dot and count that shows or hides it. */
const Group = styled(Surface)`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 36px;
  padding: 3px;
  border-radius: var(--radius-m);
  white-space: nowrap;
`;

const Chip = styled.button<{ $color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  box-shadow: var(--shadow);
  background: transparent;
  color: var(--muted);
  font: 600 12px / 1 var(--font-ui);
  cursor: pointer;

  i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: ${(p) => p.$color};
    box-shadow: 0 0 0 1.5px rgb(0 0 0 / 70%);
    opacity: 0.55;
  }
  small {
    color: var(--muted);
    font: 500 11px / 1 var(--font-mono);
  }
  &[aria-pressed="true"] {
    color: var(--text);
    border-color: var(--border);
    background: color-mix(in oklch, ${(p) => p.$color} 16%, transparent);
  }
  &[aria-pressed="true"] i {
    opacity: 1;
  }
  &:hover {
    color: var(--text);
    border-color: var(--hud-line);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

export default function FishLegend() {
  const { windowed, atMs, hidden } = useFish();
  // Counted before the switches, so a hidden species still shows what turning it back on would draw.
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const s of windowed) if (s.date !== null && Date.parse(s.date) <= atMs) out.set(s.species, (out.get(s.species) ?? 0) + 1);
    return out;
  }, [windowed, atMs]);

  return (
    <Group role="group" aria-label="Species" data-testid="fish-legend">
      {SPECIES_COLORS.map((s) => {
        const on = !hidden.includes(s.name);
        return (
          <Chip key={s.name} type="button" $color={s.color} aria-pressed={on} aria-label={`${s.name}: ${counts.get(s.name) ?? 0} sightings. ${on ? "Hide" : "Show"} them`} onClick={() => toggleSpecies(s.name)}>
            <i aria-hidden="true" />
            {s.name.replace(" carp", "")}
            <small>{counts.get(s.name) ?? 0}</small>
          </Chip>
        );
      })}
    </Group>
  );
}
